import { init } from "@nimiq/mini-app-sdk";
import type { SaveGoal, SaveGoals } from "@railkit/client";
import { breakFeeLuna, formatGoalMessage, lunaToNimString, nimStringToLuna, parseNimiqAddress } from "@railkit/core";
import { createNimiqSaver } from "@railkit/wallet-nimiq";
import { useEffect, useState } from "react";
import { api } from "../api";
import { formatMoney } from "../format";
import { AppBar, Icon, PageHead } from "../ui";
import { errorText, newNonce } from "./SaveHome";

const nim = (luna: string | bigint) => formatMoney(lunaToNimString(BigInt(luna)), "NIM");
const toDateInput = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** A date input's "YYYY-MM-DD" to midnight UTC that day. */
const fromDateInput = (s: string) => Date.parse(`${s}T00:00:00.000Z`);
const dateLabel = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const pct = (allocated: string, target: string | null) => (target && target !== "0" ? Math.min(100, Math.round((Number(allocated) / Number(target)) * 100)) : 100);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Screen = { name: "list" } | { name: "form"; goal: SaveGoal | null } | { name: "detail"; id: string } | { name: "reorder" };

/** The hint under the balance: what's free, and what's set aside for goals. An invitation to start, with no goals yet. */
export function GoalsHint({ goals, onOpen }: { goals: SaveGoals | null; onOpen: () => void }) {
  if (!goals || goals.goals.length === 0) {
    return (
      <button type="button" className="balance-link" onClick={onOpen}>
        Set a goal <Icon name="chevron" size={16} />
      </button>
    );
  }
  const inGoals = BigInt(goals.totalLuna) - BigInt(goals.withdrawableLuna);
  const filled = goals.totalLuna === "0" ? 0 : Math.round((Number(inGoals) / Number(goals.totalLuna)) * 100);
  return (
    <button type="button" className="balance-split" onClick={onOpen} aria-label={`${nim(inGoals)} in ${goals.goals.length} goals, ${nim(goals.withdrawableLuna)} free. Tap to manage your goals.`}>
      <span className="balance-split-bar"><span className="balance-split-fill" style={{ width: `${filled}%` }} /></span>
      <span className="balance-split-line">
        {nim(inGoals)} in {goals.goals.length} goal{goals.goals.length === 1 ? "" : "s"} · {nim(goals.withdrawableLuna)} free
      </span>
    </button>
  );
}

/**
 * Goals, fully: the list with progress, creating and editing one, reordering the fill queue, and breaking a dated
 * goal's lock early. Every change is a message signed in Nimiq Pay; nothing here moves money by itself.
 */
export function GoalsScreen({ address, onInner }: { address: string | null; onInner: (inner: boolean) => void }) {
  const [goals, setGoals] = useState<SaveGoals | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [screen, setScreen] = useState<Screen>({ name: "list" });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmBreak, setConfirmBreak] = useState(false);
  const self = address ? parseNimiqAddress(address) : null;
  const toList = () => setScreen({ name: "list" });
  // Every screen but the list has its own back button, so the tab bar steps aside for it.
  useEffect(() => {
    onInner(screen.name !== "list");
    return () => onInner(false);
  }, [screen.name, onInner]);

  const load = async () => {
    if (!self?.ok) return;
    try {
      setGoals(await api.saveGoals(self.value, { fresh: true }));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  async function reorder(order: string[]) {
    if (!self?.ok) return;
    setBusy(true);
    setError(null);
    try {
      const message = formatGoalMessage({ action: "reorder", address: self.value, order, time: new Date().toISOString(), nonce: newNonce() });
      const saver = createNimiqSaver(await init({ timeout: 5_000 }));
      await api.saveGoalAction({ message, ...(await saver.signRule(message)) });
      toList();
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteGoal(id: string) {
    if (!self?.ok) return;
    setBusy(true);
    setError(null);
    try {
      const message = formatGoalMessage({ action: "delete", address: self.value, goalId: id, time: new Date().toISOString(), nonce: newNonce() });
      const saver = createNimiqSaver(await init({ timeout: 5_000 }));
      await api.saveGoalAction({ message, ...(await saver.signRule(message)) });
      toList();
      setConfirmDelete(false);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function breakGoal(id: string, feeLuna: bigint) {
    if (!self?.ok) return;
    setBusy(true);
    setError(null);
    try {
      const message = formatGoalMessage({ action: "break", address: self.value, goalId: id, time: new Date().toISOString(), nonce: newNonce() });
      const saver = createNimiqSaver(await init({ timeout: 5_000 }));
      const signed = { message, ...(await saver.signRule(message)) };
      const feeTx = feeLuna > 0n ? await saver.payBreakFee(feeLuna) : undefined;
      // The fee payment may still be propagating when we ask: retry the same signed message until it's confirmed.
      for (let i = 0; i < 6; i++) {
        const r = await api.saveGoalAction(signed, { feeTx });
        if (!("pending" in r)) break;
        await sleep(2_000);
      }
      setConfirmBreak(false);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (!self?.ok) return <><PageHead title="Goals" /><p className="hint">Connecting to Nimiq Pay…</p></>;
  if (!goals) return <><PageHead title="Goals" />{error ? <p className="alert" role="alert">{error}</p> : <p className="hint" role="status">Loading your goals…</p>}</>;
  const full = goals.goals.length >= 20 || !!goals.bannedUntil;

  // ---- Creating or editing a goal.

  if (screen.name === "form") {
    return (
      <GoalForm
        address={self.value}
        goal={screen.goal}
        onBack={toList}
        onSaved={() => {
          toList();
          void load();
            }}
      />
    );
  }

  // ---- One goal: progress, and what to do with it.

  if (screen.name === "detail") {
    const g = goals.goals.find((x) => x.id === screen.id);
    if (!g) return <><AppBar title="Goal" onBack={toList} /><p className="hint">That goal is gone.</p></>;
    return (
      <div className="grow">
        <AppBar title={g.name} onBack={toList} />
        <section className="card">
          <p className="goal-amount">{nim(g.allocatedLuna)}{g.targetLuna && <span className="goal-amount-of"> of {nim(g.targetLuna)}</span>}</p>
          <div className="goal-bar"><div className="goal-bar-fill" style={{ width: `${pct(g.allocatedLuna, g.targetLuna)}%` }} /></div>
          {g.dueAt && <p className="hint">{g.done ? "Reached. " : ""}By {dateLabel(g.dueAt)}.</p>}
          {g.breached && <p className="notice">A withdrawal outside Droplets dipped into this locked goal, so its progress is lower.</p>}
        </section>
        {error && <p className="alert" role="alert">{error}</p>}
        {g.breaking ? (
          <section className="card attention-card">
            <strong className="card-title">Breaking this goal</strong>
            <p className="hint">Its money is free to withdraw from {dateLabel(g.breakReadyAt!)}. Until then, it stays locked.</p>
          </section>
        ) : g.locked ? (
          <section className="card">
            <strong className="card-title">Locked until {dateLabel(g.dueAt!)}</strong>
            <p className="hint">You can add to it, but not withdraw before then. Breaking it early costs {nim(breakFeeLuna(BigInt(g.allocatedLuna)))}, sent to Droplets, then a 24-hour wait for the rest.</p>
            {confirmBreak ? (
              <button type="button" className="danger-button" disabled={busy} onClick={() => void breakGoal(g.id, breakFeeLuna(BigInt(g.allocatedLuna)))}>
                {busy ? "Opening Nimiq Pay…" : `Pay ${nim(breakFeeLuna(BigInt(g.allocatedLuna)))} and break it`}
              </button>
            ) : (
              <button type="button" className="danger-button" disabled={busy} onClick={() => setConfirmBreak(true)}>Break this goal</button>
            )}
          </section>
        ) : null}
        <div className="row-buttons">
          <button type="button" className="secondary" onClick={() => setScreen({ name: "form", goal: g })}>Edit</button>
          {confirmDelete ? (
            <button type="button" className="danger-button" disabled={busy} onClick={() => void deleteGoal(g.id)}>{busy ? "Working…" : "Confirm delete"}</button>
          ) : (
            <button type="button" className="secondary" onClick={() => setConfirmDelete(true)}>Delete</button>
          )}
        </div>
      </div>
    );
  }

  // ---- Reordering the fill queue.

  if (screen.name === "reorder") {
    return <GoalReorder goals={goals.goals} busy={busy} onBack={toList} onSave={(ids) => void reorder(ids)} />;
  }

  // ---- The list.

  return (
    <div className="grow">
      <PageHead title="Goals">
        <button type="button" className="icon-button add-goal" aria-label="New goal" disabled={full} onClick={() => setScreen({ name: "form", goal: null })}>
          <Icon name="plus" size={24} />
        </button>
      </PageHead>
      <p className="lede">Drops fill goals in this order. A dated goal can't be withdrawn early.</p>
      {error && <p className="alert" role="alert">{error}</p>}
      {goals.bannedUntil && (
        <p className="notice">A withdrawal outside Droplets reached into a locked goal, so new goals are on hold until {dateLabel(goals.bannedUntil)}.</p>
      )}
      {goals.goals.length === 0 ? (
        <div className="empty">
          <p>No goals yet. Name your savings and set a target; drops fill it first.</p>
          <button type="button" className="primary" disabled={full} onClick={() => setScreen({ name: "form", goal: null })}>Create a goal</button>
        </div>
      ) : (
        <>
          <ul className="list goal-list">
            {goals.goals.map((g) => (
              <li key={g.id}>
                <button type="button" className="row goal-row" onClick={() => setScreen({ name: "detail", id: g.id })}>
                  <span className="row-main">
                    <strong>
                      {g.name}
                      {g.locked && <Icon name="clock" size={14} />}
                    </strong>
                    <span className="goal-bar"><span className="goal-bar-fill" style={{ width: `${pct(g.allocatedLuna, g.targetLuna)}%` }} /></span>
                    <span>{nim(g.allocatedLuna)}{g.targetLuna ? ` of ${nim(g.targetLuna)}` : ""}{g.dueAt ? ` · by ${dateLabel(g.dueAt)}` : ""}</span>
                  </span>
                  <Icon name="chevron" size={18} />
                </button>
              </li>
            ))}
          </ul>
          {goals.goals.length > 1 && <button type="button" className="text-button start" onClick={() => setScreen({ name: "reorder" })}>Change order</button>}
        </>
      )}
    </div>
  );
}

/** Create or edit one goal: a name, an optional target and an optional date. */
function GoalForm({ address, goal, onBack, onSaved }: { address: string; goal: SaveGoal | null; onBack: () => void; onSaved: () => void }) {
  const [name, setName] = useState(goal?.name ?? "");
  const [target, setTarget] = useState(goal?.targetLuna ? lunaToNimString(BigInt(goal.targetLuna)) : "");
  const [due, setDue] = useState(goal?.dueAt ? toDateInput(goal.dueAt) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) return setError("Give the goal a name.");
    let targetLuna: bigint | null = null;
    if (target.trim()) {
      const t = nimStringToLuna(target.trim());
      if (!t.ok || t.value <= 0n) return setError("Enter a target above 0 NIM.");
      targetLuna = t.value;
    }
    const dueAt = due ? fromDateInput(due) : null;
    if (due && Number.isNaN(dueAt)) return setError("That date didn't read clearly.");
    setBusy(true);
    setError(null);
    try {
      const message = formatGoalMessage(
        goal
          ? { action: "edit", address, goalId: goal.id, name: trimmed, targetLuna, dueAt, time: new Date().toISOString(), nonce: newNonce() }
          : { action: "create", address, name: trimmed, targetLuna, dueAt, time: new Date().toISOString(), nonce: newNonce() },
      );
      const saver = createNimiqSaver(await init({ timeout: 5_000 }));
      await api.saveGoalAction({ message, ...(await saver.signRule(message)) });
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grow">
      <AppBar title={goal ? "Edit goal" : "New goal"} onBack={onBack} />
      <section className="form-section">
        <div className="field">
          <label htmlFor="goal-name">Name</label>
          <input id="goal-name" value={name} maxLength={60} placeholder="School fees" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="goal-target">Target (optional)</label>
          <div className="amount-field">
            <input id="goal-target" className="amount-input" inputMode="decimal" placeholder="0" value={target} onChange={(e) => setTarget(e.target.value)} />
            <span className="amount-unit">NIM</span>
          </div>
          <p className="hint">Blank means no set amount: it takes every drop.</p>
        </div>
        <div className="field">
          <label htmlFor="goal-due">Date (optional)</label>
          <DateField value={due} onChange={setDue} />
        </div>
      </section>
      {error && <p className="alert" role="alert">{error}</p>}
      <div className="bottom">
        <button type="button" className="primary" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? "Opening Nimiq Pay…" : goal ? "Save changes" : "Create goal"}</button>
        <p className="note center">You sign in Nimiq Pay. Signing is free.</p>
      </div>
    </div>
  );
}

/** Reordering the fill queue: move a goal up or down, then sign the new order in one message. */
function GoalReorder({ goals, busy, onBack, onSave }: { goals: SaveGoal[]; busy: boolean; onBack: () => void; onSave: (order: string[]) => void }) {
  const [order, setOrder] = useState(goals.map((g) => g.id));
  const byId = new Map(goals.map((g) => [g.id, g]));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setOrder(next);
  };
  return (
    <div className="grow">
      <AppBar title="Change order" onBack={onBack} />
      <p className="lede">Drops fill the first goal, then the next. Move one to change the order.</p>
      <ul className="list goal-list">
        {order.map((id, i) => (
          <li key={id}>
            <div className="row goal-row">
              <span className="row-main"><strong>{byId.get(id)!.name}</strong></span>
              <span className="goal-reorder-buttons">
                <button type="button" className="icon-button goal-move-up" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><Icon name="down" size={18} /></button>
                <button type="button" className="icon-button" aria-label="Move down" disabled={i === order.length - 1} onClick={() => move(i, 1)}><Icon name="down" size={18} /></button>
              </span>
            </div>
          </li>
        ))}
      </ul>
      <div className="bottom">
        <button type="button" className="primary" disabled={busy} onClick={() => onSave(order)}>{busy ? "Opening Nimiq Pay…" : "Save order"}</button>
      </div>
    </div>
  );
}

/** Midnight UTC today, as "YYYY-MM-DD". */
const todayInput = () => toDateInput(Date.now());
/** The date this many months from now, as "YYYY-MM-DD". */
function monthsAhead(n: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + n);
  return toDateInput(d.getTime());
}
const PRESETS: { label: string; months: number }[] = [
  { label: "1 month", months: 1 },
  { label: "3 months", months: 3 },
  { label: "6 months", months: 6 },
  { label: "1 year", months: 12 },
];

/** The goal's date: quick choices, a calendar, and a plain sentence for what the choice means. */
function DateField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ms = value ? fromDateInput(value) : null;
  const days = ms === null ? null : Math.max(0, Math.round((ms - Date.parse(`${todayInput()}T00:00:00.000Z`)) / 86_400_000));
  return (
    <div className="date-field">
      <div className="date-chips" role="group" aria-label="Pick a date">
        <button type="button" className="pill" aria-pressed={value === ""} onClick={() => onChange("")}>No date</button>
        {PRESETS.map((p) => (
          <button key={p.label} type="button" className="pill" aria-pressed={value === monthsAhead(p.months)} onClick={() => onChange(monthsAhead(p.months))}>{p.label}</button>
        ))}
      </div>
      <label className="date-pick">
        <Icon name="clock" size={20} />
        <span className="date-pick-text">{ms === null ? "Choose a date" : dateLabel(ms)}</span>
        <input id="goal-due" type="date" min={todayInput()} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Date" />
      </label>
      <p className="hint">
        {ms === null
          ? "No date means it's never locked: close it any time, or when the target is met."
          : `Locked until ${dateLabel(ms)}${days ? `, in ${days} day${days === 1 ? "" : "s"}` : ""}. Before then you can only add to it.`}
      </p>
    </div>
  );
}
