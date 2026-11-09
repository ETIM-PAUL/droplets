import { init, requestDeviceIdentifier } from "@nimiq/mini-app-sdk";
import { ApiError, type PrizeMe } from "@railkit/client";
import { formatDrawMessage, lunaToNimString, parseNimiqAddress } from "@railkit/core";
import { createNimiqSaver } from "@railkit/wallet-nimiq";
import { useEffect, useState } from "react";
import { api } from "../api";
import { formatMoney } from "../format";
import { Icon, PageHead } from "../ui";
import { errorText, newNonce } from "./SaveHome";

type Day = NonNullable<PrizeMe["week"]>["days"][number];

const nim = (luna: string | bigint) => formatMoney(lunaToNimString(BigInt(luna)), "NIM");
/** "Sunday 11:59 PM", in the phone's own time zone. */
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" });
const weekday = (day: string, style: "narrow" | "long") => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: style, timeZone: "UTC" });
const weekOf = (week: string) => new Date(`${week}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
const DAY_LABEL: Record<Day["status"], string> = { kept: "kept", missed: "missed", today: "today, so far", ahead: "still to come" };

/** The draw's state for this person: loaded once, then refreshed after they join or leave. */
function usePrize(address: string | null) {
  const [me, setMe] = useState<PrizeMe | null>(null);
  const [off, setOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const self = address ? parseNimiqAddress(address) : null;
  const load = async () => {
    if (!self?.ok) return;
    try {
      setMe(await api.prizeMe(self.value));
      setError(null);
    } catch (e) {
      // Switched off on this server: no draw at all.
      if (e instanceof ApiError && e.status === 503 && /switched off/.test(e.message)) setOff(true);
      else setError(errorText(e));
    }
  };
  useEffect(() => {
    void load();
    // Reload when the account changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);
  return { me, off, error, setError, load, self };
}

/** The week as seven coins: gold when kept, crossed when missed, outlined for today, dashed for days to come. */
function Coins({ days, min }: { days: Day[]; min: bigint }) {
  // Today counts as missed as soon as it has dipped under the minimum.
  const shown = days.map((d) => ({ ...d, status: d.status === "today" && d.lowLuna !== null && BigInt(d.lowLuna) < min ? ("missed" as const) : d.status }));
  return (
    <ol className="coins" aria-label="This week">
      {shown.map((d) => (
        <li key={d.day} className={`coin ${d.status}`} aria-label={`${weekday(d.day, "long")}: ${DAY_LABEL[d.status]}`}>
          <span className="coin-face" aria-hidden="true">
            {d.status === "kept" ? <Icon name="check" size={16} /> : d.status === "missed" ? <Icon name="close" size={14} /> : null}
          </span>
          <span className="coin-day" aria-hidden="true">{weekday(d.day, "narrow")}</span>
        </li>
      ))}
    </ol>
  );
}

/** Where this week stands, in one sentence. */
function standing(me: PrizeMe): string {
  const r = me.rules;
  const w = me.week;
  if (!me.joined || !w) return `Keep at least ${nim(r.minLuna)} saved on ${r.daysNeeded} days of the week to get in.`;
  if (w.tooManyTransactions) return "This account has too many transactions this week for Droplets to check, so it can't enter this week's draw.";
  if (w.tickets > 0) return `You're in, with ${w.tickets} ticket${w.tickets === 1 ? "" : "s"} for keeping ${nim(w.keptLuna)}.`;
  const ahead = w.days.filter((d) => d.status === "ahead").length;
  const still = r.daysNeeded - w.daysKept;
  return still <= ahead
    ? `${w.daysKept} of ${r.daysNeeded} days so far. Keep at least ${nim(r.minLuna)} saved for ${still} more day${still === 1 ? "" : "s"} to get in.`
    : `This week can't reach ${r.daysNeeded} days any more. A new week starts on Monday.`;
}

/**
 * The weekly draw. `compact` is Home's summary, which opens the Draw tab; the full card joins, shows the week, the
 * latest result, and lets people leave.
 */
export function DrawCard({ address, compact, onOpen }: { address: string | null; compact?: boolean; onOpen?: () => void }) {
  const { me, off, error, setError, load, self } = usePrize(address);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  // ---- Tap handlers. Each opens Nimiq Pay's own dialog; the signing guard checks they stay that way.

  async function joinDraw() {
    if (!self?.ok || !me) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      // One entry per phone. Nimiq Pay asks the person before it shares this.
      const device = await requestDeviceIdentifier({ reason: "The weekly draw allows one entry per phone." }).catch(() => {
        throw new Error("Droplets needs Nimiq Pay to recognise this phone, so each phone enters once. If Nimiq Pay didn't ask you, update it and try again.");
      });
      const message = formatDrawMessage({ action: "join", address: self.value, time: new Date().toISOString(), nonce: newNonce() });
      const saver = createNimiqSaver(await init({ timeout: 5_000 }));
      await api.prizeJoin({ message, ...(await saver.signRule(message)), device });
      await load();
      setInfo(`You're in. Keep at least ${nim(me.rules.minLuna)} saved on ${me.rules.daysNeeded} days of the week.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function leaveDraw() {
    if (!self?.ok) return;
    setBusy(true);
    setError(null);
    try {
      const message = formatDrawMessage({ action: "leave", address: self.value, time: new Date().toISOString(), nonce: newNonce() });
      const saver = createNimiqSaver(await init({ timeout: 5_000 }));
      await api.prizeJoin({ message, ...(await saver.signRule(message)) });
      setConfirmLeave(false);
      await load();
      setInfo("You've left the draw. Your savings stay where they are.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (off || !self?.ok) return null;
  if (!me) return error && !compact ? <p className="alert" role="alert">{error}</p> : null;

  const r = me.rules;
  const min = BigInt(r.minLuna);
  const title = (
    <span className="draw-title">
      <span className="draw-badge"><Icon name="gift" size={18} /></span>
      <strong>Win {nim(r.prizeLuna)} every Sunday</strong>
    </span>
  );

  if (compact) {
    return (
      <button type="button" className="card draw-card draw-summary" onClick={onOpen} aria-label={`Weekly draw. ${standing(me)}`}>
        <span className="draw-summary-head">
          {title}
          <span className="setting-chevron"><Icon name="chevron" size={18} /></span>
        </span>
        {me.joined && me.week && <Coins days={me.week.days} min={min} />}
        <span className="hint">{me.joined ? standing(me) : `Keep ${nim(r.minLuna)} saved on ${r.daysNeeded} days a week to enter. Tap to join.`}</span>
      </button>
    );
  }

  const messages = (
    <>
      {error && <p className="alert" role="alert">{error}</p>}
      {info && <p className="toast" role="status">{info}</p>}
    </>
  );
  const last = me.lastDraw;

  return (
    <section className="card draw-card" aria-label="Weekly draw">
      {title}
      {me.joined && me.week ? (
        <>
          <Coins days={me.week.days} min={min} />
          <p className="draw-status">{standing(me)}</p>
          <p className="hint">The draw is {when(me.week.drawAt)}. The prize goes straight into the winner's savings.</p>
        </>
      ) : (
        <p className="hint">Keep at least {nim(r.minLuna)} saved on {r.daysNeeded} of the 7 days and you're in that Sunday's draw. Keep more for more tickets: every 10 times as much adds one, up to {r.maxTickets}.</p>
      )}
      {last && (
        <p className="note">
          {last.youWon
            ? `You won the draw for the week of ${weekOf(last.week)}! ${nim(last.prizeLuna)} ${last.paid ? "has been paid to you" : "is on its way to you"}.`
            : last.winner
              ? `Week of ${weekOf(last.week)}: ${last.entries} saver${last.entries === 1 ? "" : "s"} with ${last.totalTickets} ticket${last.totalTickets === 1 ? "" : "s"}. ${last.winner} won, picked with Nimiq block ${last.blockNumber.toLocaleString()}.`
              : `Nobody qualified in the week of ${weekOf(last.week)}.`}
        </p>
      )}
      {messages}
      {!me.joined || !me.week ? (
        <>
          <button type="button" className="primary gold" disabled={busy} onClick={() => void joinDraw()}>{busy ? "Opening Nimiq Pay…" : "Join the draw"}</button>
          <p className="note">Nimiq Pay asks to recognise this phone, so each phone enters once, and asks you to sign. Both are free.</p>
        </>
      ) : confirmLeave ? (
        <div className="row-buttons">
          <button type="button" className="secondary" onClick={() => setConfirmLeave(false)}>Stay in</button>
          <button type="button" className="danger-button" disabled={busy} onClick={() => void leaveDraw()}>{busy ? "Opening Nimiq Pay…" : "Leave"}</button>
        </div>
      ) : (
        <button type="button" className="text-button start" onClick={() => setConfirmLeave(true)}>Leave the draw</button>
      )}
    </section>
  );
}

/** The Draw tab: this week, how the draw works, and anything you've won. */
export function DrawTab({ address }: { address: string | null }) {
  const { me } = usePrize(address);
  const r = me?.rules;
  return (
    <>
      <PageHead title="Weekly draw" />
      <DrawCard address={address} />
      {r && (
        <section className="section">
          <h2 className="section-title">How it works</h2>
          <ul className="group explain">
            <li><Icon name="drop" size={20} /><span>Keep at least {nim(r.minLuna)} in your savings on {r.daysNeeded} of the 7 days, Monday to Sunday.</span></li>
            <li><Icon name="plus" size={20} /><span>Keep more for more tickets: every 10 times as much adds one, up to {r.maxTickets}.</span></li>
            <li><Icon name="gift" size={20} /><span>When the week closes on Sunday night, the first Nimiq block after it picks the winner, so nobody can know it in advance. The prize goes into the winner's savings.</span></li>
            <li><Icon name="check" size={20} /><span>You never risk your savings. Taking money out only costs you days this week.</span></li>
          </ul>
        </section>
      )}
      {me && me.wins.length > 0 && (
        <section className="section">
          <h2 className="section-title">Your wins</h2>
          <ul className="list">
            {me.wins.map((w) => (
              <li key={w.week}>
                <div className="row">
                  <span className="row-icon prize"><Icon name="gift" size={20} /></span>
                  <span className="row-main"><strong>Week of {weekOf(w.week)}</strong><span>{w.paid ? "Paid into your savings" : "Paying out soon"}</span></span>
                  <span className="row-end"><span className="row-amount">+{nim(w.prizeLuna)}</span></span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
