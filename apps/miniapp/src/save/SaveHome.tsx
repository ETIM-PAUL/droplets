import { init } from "@nimiq/mini-app-sdk";
import type { SaveIntent } from "@railkit/agent";
import type { SaveApp, SaveCatchUp, SaveMe, SaveValidator } from "@railkit/client";
import { CATCH_UP_EVERY, checkWithdrawal, formatSaveMessage, lunaToNimString, MIN_STAKE_LUNA, nimStringToLuna, parseNimiqAddress, WalletError, type CatchUpEvery, type StakerState } from "@railkit/core";
import { createNimiqSaver } from "@railkit/wallet-nimiq";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatMoney } from "../format";
import { api, hostNetwork } from "../api";
import { ReportProblem } from "../ReportProblem";
import { AppBar, Hexagon, Icon, PageHead, QrCode, SettingRow, type IconName, type Tab } from "../ui";

type Mode = "home" | "rule" | "open" | "add" | "withdraw";

const PRESETS = [10, 30, 50, 100];
/** Shares saved on top when paying an app: small, since they're added to the price. */
const SPEND_PRESETS = [0, 5, 10, 20];
const CATCH_UP_LABEL: Record<CatchUpEvery, string> = { daily: "Daily", weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly" };
const CATCH_UP_PERIOD: Record<CatchUpEvery, string> = { daily: "day", weekly: "week", biweekly: "two weeks", monthly: "month" };
/** The phone's time zone, so a week or a month starts when it does for the user. */
const tzOffset = () => -new Date().getTimezoneOffset();
const dayName = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
/** Payments in shown on Home; Activity has the rest. */
const RECENT_SHOWN = 4;
const nim = (luna: string | bigint) => formatMoney(lunaToNimString(BigInt(luna)), "NIM");
const shortAddress = (a: string) => `${a.slice(0, 4)} … ${a.slice(-4)}`;
export const newNonce = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
const stakerOf = (g: NonNullable<SaveMe["grow"]>): StakerState => ({
  active: BigInt(g.active), inactive: BigInt(g.inactive), inactiveFrom: g.inactiveFrom, retired: BigInt(g.retired), delegation: g.delegation,
});
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Blocks are one second apart, so a block count reads as time. */
const roughly = (blocks: number) => {
  const minutes = Math.ceil(Math.max(0, blocks) / 60);
  if (minutes <= 1) return "about a minute";
  if (minutes < 90) return `about ${minutes} minutes`;
  return `about ${Math.round(minutes / 60)} hours`;
};

/** What went wrong, in words the person can act on. */
export const errorText = (e: unknown) => {
  if (e instanceof WalletError) {
    if (e.kind === "rejected") return "You cancelled in Nimiq Pay. Nothing changed.";
    if (e.kind === "unknown") return "Nimiq Pay didn't confirm. Check its history before trying again.";
    return e.message;
  }
  return e instanceof Error ? e.message : "Something went wrong. Try again.";
};

interface Props {
  address: string | null;
  /** Home: the balance, what needs the user and what came in. Profile: the save code, the rules and help. */
  tab: "home" | "profile";
  /** A request from the chat ("put 500 NIM in savings"): opens the screen for it, filled in. Nothing happens until the user taps. */
  start?: { intent: SaveIntent; notes: string[] } | null;
  /** Called once the request has been opened, so it isn't opened twice. */
  onStarted?: () => void;
  /** The weekly draw at a glance, on Home. It doesn't need a save code. */
  draw?: ReactNode;
  onTab: (t: Tab) => void;
  /** Opens Ask Errand. */
  onAsk: () => void;
  /** Opens How Errand works. */
  onHelp: () => void;
  /** Told when an inner screen (rules, add, withdraw, open) opens or closes, so the tab bar can step aside. */
  onInner?: (inner: boolean) => void;
}

export function SaveHome({ address, tab, start, onStarted, draw, onTab, onAsk, onHelp, onInner }: Props) {
  const [me, setMe] = useState<SaveMe | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("home");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [percent, setPercent] = useState(30);
  const [spendPercent, setSpendPercent] = useState(0);
  /** Names of the apps allowed to recognise the user's address, as they'll appear in the signed rule. */
  const [chosen, setChosen] = useState<string[]>([]);
  const [apps, setApps] = useState<SaveApp[] | null>(null);
  const [catchUpEvery, setCatchUpEvery] = useState<CatchUpEvery>("weekly");
  const [catchUp, setCatchUp] = useState<SaveCatchUp | null>(null);
  /** Catch-up answers are numbered so a slower, older one can't overwrite a newer one. */
  const catchUpSeq = useRef(0);
  /** A catch-up just paid for, until the chain shows it: no second Save button meanwhile. */
  const [paidFor, setPaidFor] = useState<{ to: number; luna: bigint; at: number } | null>(null);
  const [amount, setAmount] = useState("");
  const [validators, setValidators] = useState<SaveValidator[] | null>(null);
  const [validator, setValidator] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  /** The validator list on Open savings: the recommended one is picked; the rest show on request. */
  const [showValidators, setShowValidators] = useState(false);
  const [showQr, setShowQr] = useState(false);

  const self = address ? parseNimiqAddress(address) : null;
  const load = async (fresh = false) => {
    if (!self?.ok) return;
    try {
      const m = await api.saveMe(self.value, fresh);
      setMe(m);
      setLoadError(null);
      if (m.savePercent !== null) setPercent(m.savePercent);
      if (m.spendPercent !== null) setSpendPercent(m.spendPercent);
      if (m.catchUp !== null) setCatchUpEvery(m.catchUp);
      setChosen(m.apps.map((a) => a.name));
      // The catch-up is extra: if it can't load, the rest of Savings still works.
      const seq = ++catchUpSeq.current;
      const show = (c: SaveCatchUp | null) => void (seq === catchUpSeq.current && setCatchUp(c));
      if (m.spendPercent) void api.saveCatchUp(self.value, tzOffset(), fresh).then(show, () => show(null));
      else show(null);
      return m;
    } catch (e) {
      setLoadError(errorText(e));
    }
  };
  /** After a staking transaction: the chain shows it within seconds; check a few times. */
  const waitFor = async (done: (m: SaveMe) => boolean) => {
    for (let i = 0; i < 10; i++) {
      await sleep(3_000);
      const m = await load(true);
      if (m && done(m)) return true;
    }
    return false;
  };

  useEffect(() => {
    void load();
    // Reload when the account changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  useEffect(() => {
    if (mode !== "rule" || apps) return;
    api.saveApps().then(setApps, (e) => setError(errorText(e)));
  }, [mode, apps]);

  useEffect(() => {
    if (mode !== "open" || validators) return;
    api.saveValidators().then(
      (v) => {
        setValidators(v);
        setValidator((cur) => cur ?? v[0]?.address ?? null);
      },
      (e) => setError(errorText(e)),
    );
  }, [mode, validators]);

  // The chat's request, once the savings are loaded. It only opens and fills in a screen.
  useEffect(() => {
    if (!start || !me) return;
    onStarted?.();
    const { intent, notes } = start;
    setError(null);
    setInfo(notes[0] ?? null);
    setConfirmRevoke(false);
    const g = me.grow;
    switch (intent.action) {
      case "rule":
        if (intent.savePercent !== undefined) setPercent(intent.savePercent);
        // Without a code yet, Home shows the next setup step with this share picked.
        setMode(me.code ? "rule" : "home");
        break;
      case "add":
        if (g) {
          setAmount(intent.nim ?? "");
          setMode("add");
        } else {
          const enough = intent.nim !== undefined && Number(intent.nim) >= 100;
          setAmount(enough ? intent.nim! : "100");
          setInfo("Your savings aren't open yet, so this opens them. They start with at least 100 NIM.");
          setMode("open");
        }
        break;
      case "withdraw":
        if (g && BigInt(g.active) > 0n) {
          setAmount(intent.all ? lunaToNimString(BigInt(g.active)) : intent.nim ?? "");
          setMode("withdraw");
        } else {
          setMode("home");
          setInfo("There's nothing in your savings to withdraw right now.");
        }
        break;
      case "revoke":
        setMode("home");
        onTab("profile");
        if (me.code) setConfirmRevoke(true);
        else setInfo("You don't have a save code to turn off.");
        break;
      case "show":
        setMode("home");
        break;
    }
    // Only when a new request arrives or the savings first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, me]);

  useEffect(() => {
    onInner?.(mode !== "home");
    window.scrollTo({ top: 0 });
    // Only when the screen changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const go = (m: Mode) => {
    setError(null);
    setInfo(null);
    setAmount(m === "open" ? "100" : "");
    // The rules screen starts from what's saved, not from changes left unsigned last time.
    if (m === "rule" && me) {
      setPercent(me.savePercent ?? 30);
      setSpendPercent(me.spendPercent ?? 0);
      setCatchUpEvery(me.catchUp ?? "weekly");
      setChosen(me.apps.map((a) => a.name));
    }
    setMode(m);
  };

  // ---- Tap handlers. Each opens Nimiq Pay's own dialog; the signing guard checks they stay that way.

  /** Signs all three rules in one message: the share of payouts, the share on top when paying, and the apps allowed. */
  async function saveRule(rules: { savePercent: number; spendPercent: number; apps: string[]; catchUp: CatchUpEvery }) {
    if (!self?.ok) return;
    setBusy(true);
    setError(null);
    try {
      const message = formatSaveMessage({ action: "set", address: self.value, ...rules, time: new Date().toISOString(), nonce: newNonce() });
      const saver = createNimiqSaver(await init({ timeout: 5_000 }));
      const signed = await saver.signRule(message);
      await api.saveRule({ message, ...signed, tzOffsetMinutes: tzOffset() });
      await load(true);
      setMode("home");
      setInfo(`Rules saved. ${rules.savePercent}% of what apps pay you goes to savings${rules.spendPercent ? `, and ${rules.spendPercent}% more when you pay one` : ""}.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function openGrow() {
    const luna = nimStringToLuna(amount);
    if (!luna.ok) return setError(luna.error.message);
    if (luna.value < MIN_STAKE_LUNA) return setError("Start with at least 100 NIM. That's Nimiq's minimum for staking.");
    if (!validator) return setError("Choose a validator first.");
    setBusy(true);
    setError(null);
    try {
      const saver = createNimiqSaver(await init({ timeout: 5_000 }));
      await saver.openGrow(validator, luna.value);
      setInfo("Your savings are opening. They show here within a minute.");
      setMode("home");
      const open = await waitFor((m) => m.grow !== null);
      if (open && !me?.code) setInfo("Your savings are open. Now choose your share and get your save code.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function addToGrow() {
    const luna = nimStringToLuna(amount);
    if (!luna.ok) return setError(luna.error.message);
    if (luna.value <= 0n) return setError("Enter an amount to add.");
    const before = me?.grow ? BigInt(me.grow.active) : 0n;
    setBusy(true);
    setError(null);
    try {
      const saver = createNimiqSaver(await init({ timeout: 5_000 }));
      await saver.addToGrow(luna.value);
      setInfo(`Adding ${nim(luna.value)} to your savings.`);
      setMode("home");
      await waitFor((m) => !!m.grow && BigInt(m.grow.active) > before);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function startWithdrawal() {
    if (!me?.grow) return;
    const luna = nimStringToLuna(amount);
    if (!luna.ok) return setError(luna.error.message);
    const check = checkWithdrawal(stakerOf(me.grow), luna.value);
    if (!check.ok) return setError(check.error.message);
    setBusy(true);
    setError(null);
    try {
      const saver = createNimiqSaver(await init({ timeout: 5_000 }));
      await saver.startWithdrawal(check.value.newActive);
      setInfo(`Withdrawing ${nim(luna.value)}. It's ready in 12 to 24 hours; finish it here then.`);
      setMode("home");
      await waitFor((m) => !!m.grow && BigInt(m.grow.inactive) > 0n);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function finishWithdrawal() {
    if (!me?.grow) return;
    setBusy(true);
    setError(null);
    try {
      const saver = createNimiqSaver(await init({ timeout: 5_000 }));
      let retired = BigInt(me.grow.retired);
      if (retired === 0n) {
        // Two Nimiq Pay approvals: retire the released stake, then take it back to the wallet.
        await saver.retire(BigInt(me.grow.inactive));
        setInfo("Released. Approve once more to move it to your wallet.");
        await waitFor((m) => !!m.grow && BigInt(m.grow.retired) > 0n);
        const now = await load(true);
        retired = now?.grow ? BigInt(now.grow.retired) : 0n;
        if (retired === 0n) return setInfo("Released. Tap Finish withdrawal again in a minute to move it to your wallet.");
      }
      await saver.remove(retired);
      setInfo(`${nim(retired)} is on its way to your wallet.`);
      await waitFor((m) => !m.grow || BigInt(m.grow.retired) === 0n);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  /** Saves the catch-up: the user's share of what they spent, into Grow, with one approval in Nimiq Pay. */
  async function saveCatchUp() {
    if (!self?.ok || catchUp?.status !== "due") return;
    const owed = BigInt(catchUp.owed);
    setBusy(true);
    setError(null);
    try {
      const saver = createNimiqSaver(await init({ timeout: 5_000 }));
      await saver.addToGrow(owed);
      setPaidFor({ to: catchUp.to, luna: owed, at: Date.now() });
      setInfo(`Saving ${nim(owed)}.`);
      // The chain shows it within seconds; check a few times until the catch-up counts it.
      for (let i = 0; i < 10; i++) {
        await sleep(3_000);
        const seq = ++catchUpSeq.current;
        const c = await api.saveCatchUp(self.value, tzOffset(), true).catch(() => null);
        if (seq !== catchUpSeq.current || !c) continue;
        setCatchUp(c);
        if (c.status !== "due" || BigInt(c.owed) < owed) {
          setPaidFor(null);
          if (c.status === "done") setInfo(`Caught up: ${nim(owed)} saved. The next catch-up is on ${dayName(c.next)}.`);
          break;
        }
      }
      await load(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function revokeCode() {
    if (!self?.ok) return;
    setBusy(true);
    setError(null);
    try {
      const message = formatSaveMessage({ action: "revoke", address: self.value, time: new Date().toISOString(), nonce: newNonce() });
      const saver = createNimiqSaver(await init({ timeout: 5_000 }));
      const signed = await saver.signRule(message);
      await api.saveRule({ message, ...signed });
      setConfirmRevoke(false);
      await load(true);
      setInfo("Your save code is off. Apps that have it now pay your wallet.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  // ---- Screens.

  const copy = (text: string, done: string) => {
    // The clipboard needs HTTPS. Over plain http (a phone on the dev machine's Wi-Fi) there is none, so show it instead.
    const show = () => setInfo(text);
    if (!navigator.clipboard) return show();
    void navigator.clipboard.writeText(text).then(() => setInfo(done), show);
  };
  const pageTitle = tab === "home" ? "Savings" : "Profile";
  if (!self?.ok) return <><PageHead title={pageTitle} /><p className="hint">Connecting to Nimiq Pay…</p></>;
  if (!me) {
    return (
      <>
        <PageHead title={pageTitle} />
        {loadError ? (
          <div className="card">
            <p className="alert" role="alert">{loadError}</p>
            <button type="button" className="secondary" onClick={() => void load()}>Try again</button>
          </div>
        ) : (
          <div className="skeletons" role="status" aria-label="Loading your savings">
            <div className="skeleton tall" />
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
        )}
      </>
    );
  }

  const wrongNetwork = me.network !== hostNetwork();
  const messages = (
    <>
      {wrongNetwork && <p className="notice" role="status">Errand is on Nimiq {me.network}, but Nimiq Pay is on {hostNetwork()}. Switch networks in Nimiq Pay to use your savings.</p>}
      {error && <p className="alert" role="alert">{error}</p>}
      {info && <p className="toast" role="status">{info}</p>}
    </>
  );
  const example = (p: number) => `If an app pays you 1,000 NIM, ${(p * 10).toLocaleString()} NIM goes to savings and ${((100 - p) * 10).toLocaleString()} NIM to your wallet.`;
  const presets = (list: number[], value: number, set: (n: number) => void, label: string) => (
    <div className="presets" role="group" aria-label={label}>
      {(list.includes(value) ? list : [...list, value].sort((a, b) => a - b)).map((p) => (
        <button key={p} type="button" className="preset" aria-pressed={value === p} onClick={() => set(p)}>{p}%</button>
      ))}
    </div>
  );
  const picker = (
    <div className="field">
      <span className="field-label">Save from what apps pay you</span>
      {presets(PRESETS, percent, setPercent, "Share to save")}
      <p className="hint">{example(percent)}</p>
    </div>
  );

  // ---- Inner screens: a back button at the top, the one thing to do at the bottom.

  if (mode === "rule") {
    const toggle = (name: string) => setChosen((c) => (c.includes(name) ? c.filter((n) => n !== name) : [...c, name]));
    // Keep the order of Errand's list, so the signed rule reads the same way every time.
    const allowed = (apps ?? []).map((a) => a.name).filter((n) => chosen.includes(n));
    return (
      <div className="grow">
        <AppBar title="Saving rules" onBack={() => go("home")} />
        <section className="form-section">{picker}</section>
        <section className="form-section">
          <div className="field">
            <span className="field-label">Save when you pay an app</span>
            {presets(SPEND_PRESETS, spendPercent, setSpendPercent, "Share to save when you pay")}
            <p className="hint">
              {spendPercent === 0 ? "Nothing extra when you pay." : `Pay an app 100 NIM and you pay ${100 + spendPercent} NIM, with ${spendPercent} NIM going to savings. Only in apps you allow below.`}
            </p>
          </div>
          {spendPercent > 0 && (
            <div className="field">
              <span className="field-label">Catch up on other payments</span>
              <div className="presets" role="group" aria-label="How often to catch up">
                {CATCH_UP_EVERY.map((e) => (
                  <button key={e} type="button" className="preset preset-word" aria-pressed={catchUpEvery === e} onClick={() => setCatchUpEvery(e)}>{CATCH_UP_LABEL[e]}</button>
                ))}
              </div>
              <p className="hint">For payments anywhere else, Errand adds up your {spendPercent}% each {CATCH_UP_PERIOD[catchUpEvery]} and asks you to save it. Nothing moves until you approve it.</p>
            </div>
          )}
        </section>
        <section className="form-section">
          <div className="field">
            <span className="field-label">Apps that know it's you</span>
            {apps === null ? <p className="hint">Loading apps…</p> : apps.length === 0 ? <p className="hint">No apps save with Errand yet. Until they do, give apps your save code.</p> : (
              <div className="choices">
                {apps.map((a) => (
                  <button key={a.id} type="button" className="choice toggle" aria-pressed={chosen.includes(a.name)} onClick={() => toggle(a.name)}>
                    <strong>{a.name}</strong>
                    <small>{chosen.includes(a.name) ? "Saves for you" : "Tap to allow"}</small>
                  </button>
                ))}
              </div>
            )}
            <p className="hint">These apps recognise the address they already pay, so you don't need your code there. Other apps can't tell you use Errand.</p>
          </div>
        </section>
        {messages}
        <div className="bottom">
          <button type="button" className="primary" disabled={busy || wrongNetwork || apps === null} onClick={() => void saveRule({ savePercent: percent, spendPercent, apps: allowed, catchUp: catchUpEvery })}>
            {busy ? "Opening Nimiq Pay…" : "Save rules"}
          </button>
          <p className="note center">Nimiq Pay asks you to sign, so only you can change your rules. Signing is free.</p>
        </div>
      </div>
    );
  }

  if (mode === "open") {
    const picked = validators?.find((v) => v.address === validator) ?? null;
    return (
      <div className="grow">
        <AppBar title="Open your savings" onBack={() => go("home")} />
        <p className="lede">Your savings are NIM staked from your own Nimiq account. They earn staking rewards, and only you can move them.</p>
        <div className="field">
          <label htmlFor="save-open-amount">Amount</label>
          <div className="amount-field">
            <input id="save-open-amount" className="amount-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <span className="amount-unit">NIM</span>
          </div>
          <p className="hint">At least 100 NIM, Nimiq's minimum for staking. You can add more any time.</p>
        </div>
        <div className="field">
          <span className="field-label">Staked with</span>
          {validators === null ? <p className="hint">Loading validators…</p> : (
            <div className="choices">
              {(showValidators ? validators.slice(0, 8) : picked ? [picked] : []).map((v) => (
                <button key={v.address} type="button" className="choice" aria-pressed={validator === v.address} onClick={() => { setValidator(v.address); setShowValidators(false); }}>
                  <strong>{v.name ?? shortAddress(v.address)}</strong>
                  <small>{v.numStakers.toLocaleString()} stakers, {nim(v.stakeLuna)} staked</small>
                </button>
              ))}
            </div>
          )}
          {!showValidators && (validators?.length ?? 0) > 1 && <button type="button" className="text-button start" onClick={() => setShowValidators(true)}>Choose another validator</button>}
          <p className="hint">The validator does the staking. It can never move your NIM.</p>
        </div>
        {messages}
        <div className="bottom">
          <button type="button" className="primary" disabled={busy || wrongNetwork || !validator} onClick={() => void openGrow()}>{busy ? "Opening Nimiq Pay…" : `Open savings with ${amount || "0"} NIM`}</button>
        </div>
      </div>
    );
  }

  if (mode === "add" || mode === "withdraw") {
    const adding = mode === "add";
    const max = me.grow ? BigInt(me.grow.active) : 0n;
    return (
      <div className="grow">
        <AppBar title={adding ? "Add to savings" : "Withdraw"} onBack={() => go("home")} />
        <div className="field">
          <label htmlFor="save-amount">{adding ? "How much to add" : "How much to withdraw"}</label>
          <div className="amount-field">
            <input id="save-amount" className="amount-input" inputMode="decimal" value={amount} placeholder="0" onChange={(e) => setAmount(e.target.value)} />
            <span className="amount-unit">NIM</span>
          </div>
          {adding ? (
            <>
              <div className="amount-chips" role="group" aria-label="Amounts">
                {[100, 500, 1_000].map((n) => (
                  <button key={n} type="button" className="suggestion" aria-pressed={amount === String(n)} onClick={() => setAmount(String(n))}>{n.toLocaleString()} NIM</button>
                ))}
              </div>
              <p className="hint">It moves from your Nimiq Pay wallet into your savings.</p>
            </>
          ) : (
            <p className="hint">You have {nim(max)} in savings. <button type="button" className="text-button inline" onClick={() => setAmount(lunaToNimString(max))}>Withdraw all</button></p>
          )}
        </div>
        {!adding && <p className="notice">Withdrawing takes 12 to 24 hours, because Nimiq releases staked NIM at the end of an epoch. Then you finish it on Home, with two approvals in Nimiq Pay.</p>}
        {messages}
        <div className="bottom">
          <button type="button" className="primary" disabled={busy || wrongNetwork || !amount.trim()} onClick={() => void (adding ? addToGrow() : startWithdrawal())}>
            {busy ? "Opening Nimiq Pay…" : adding ? `Add ${amount || "0"} NIM` : `Withdraw ${amount || "0"} NIM`}
          </button>
        </div>
      </div>
    );
  }

  const g = me.grow;
  const total = g ? BigInt(g.active) + BigInt(g.inactive) + BigInt(g.retired) : 0n;
  const released = !!g && BigInt(g.inactive) > 0n && g.releaseBlock !== null && me.blockNumber >= g.releaseBlock;
  const leaving = !!g && BigInt(g.inactive) > 0n && !released;
  const due = catchUp?.status === "due" ? catchUp : null;
  const paying = !!due && !!paidFor && paidFor.to === due.to && BigInt(due.owed) >= paidFor.luna && Date.now() - paidFor.at < 10 * 60_000;

  // ---- Profile: the account, the save code, the rules, help.

  if (tab === "profile") {
    return (
      <>
        <PageHead title="Profile">{me.network === "testnet" && <span className="chip">Testnet</span>}</PageHead>
        {messages}
        <section className="card account-card" aria-label="Your Nimiq account">
          <span className="avatar"><Icon name="user" /></span>
          <span className="account-main">
            <strong>Your Nimiq account</strong>
            <span>{shortAddress(me.address)}</span>
          </span>
          <button type="button" className="icon-button" aria-label="Copy your address" onClick={() => copy(me.address, "Address copied.")}><Icon name="copy" size={20} /></button>
        </section>

        {me.code ? (
          <section className="card code-card" aria-label="Your save code">
            <span className="card-label">Your save code</span>
            <p className="save-code">{me.code}</p>
            <p className="hint">Give it to apps that ask where to pay you. Apps you allow below don't need it.</p>
            <div className="row-buttons">
              <button type="button" className="secondary" onClick={() => copy(me.code!, "Code copied.")}><Icon name="copy" size={18} /> Copy</button>
              <button type="button" className="secondary" aria-expanded={showQr} onClick={() => setShowQr((v) => !v)}><Icon name="qr" size={18} /> {showQr ? "Hide QR" : "Show QR"}</button>
            </div>
            {showQr && (
              <div className="qr-wrap">
                <QrCode text={me.code} label={`QR code for ${me.code}`} />
                <p className="hint">An app that pays you can scan this instead of typing your code.</p>
              </div>
            )}
          </section>
        ) : (
          <section className="card">
            <strong>No save code yet</strong>
            <p className="hint">Open your savings and choose your share on Home. Your code and rules then show here.</p>
            <button type="button" className="secondary" onClick={() => onTab("home")}>Go to Home</button>
          </section>
        )}

        {me.code && (
          <section className="section">
            <h2 className="section-title">Saving rules</h2>
            <div className="group">
              <SettingRow icon="down" label="When an app pays you" value={`${me.savePercent}%`} onClick={() => go("rule")} />
              <SettingRow icon="tag" label="When you pay an app" value={me.spendPercent ? `${me.spendPercent}% on top` : "Off"} onClick={() => go("rule")} />
              {me.spendPercent ? <SettingRow icon="repeat" label="Catch-up" value={CATCH_UP_LABEL[me.catchUp ?? "weekly"]} onClick={() => go("rule")} /> : null}
              <SettingRow icon="apps" label="Apps that know it's you" value={me.apps.length ? `${me.apps.length} ${me.apps.length === 1 ? "app" : "apps"}` : "None"} onClick={() => go("rule")} />
            </div>
            {catchUp && catchUp.status !== "off" && catchUp.status !== "due" && <p className="note">Next catch-up on {dayName(catchUp.next)}.</p>}
          </section>
        )}

        <section className="section">
          <h2 className="section-title">Help</h2>
          <div className="group">
            <SettingRow icon="help" label="How Errand works" onClick={onHelp} />
            <SettingRow icon="chat" label="Ask Errand" onClick={onAsk} />
          </div>
          <ReportProblem />
        </section>

        {me.code && (
          <section className="section">
            {confirmRevoke ? (
              <div className="card">
                <strong>Turn off your save code?</strong>
                <p className="hint">Apps that have it will pay your wallet instead. Your savings stay where they are.</p>
                <div className="row-buttons">
                  <button type="button" className="secondary" onClick={() => setConfirmRevoke(false)}>Keep it</button>
                  <button type="button" className="danger-button" disabled={busy || wrongNetwork} onClick={() => void revokeCode()}>{busy ? "Opening Nimiq Pay…" : "Turn off"}</button>
                </div>
              </div>
            ) : (
              <div className="group">
                <SettingRow label="Turn off my save code" onClick={() => setConfirmRevoke(true)} danger />
              </div>
            )}
          </section>
        )}
      </>
    );
  }

  // ---- Home: what you have, what needs you, what came in.

  const balanceSub = !g
    ? me.growClosed === "validator-gone" ? "Your validator has closed. Move your stake in Nimiq Pay." : "Not started yet"
    : g.validatorJailed ? "Your validator is paused, so rewards and withdrawals wait." : "Staked in your own Nimiq account and earning rewards. Only you can move it.";
  return (
    <>
      <header className="page-head">
        <span className="brand"><Hexagon size={22} /><h1>Errand</h1></span>
        {me.network === "testnet" && <span className="chip">Testnet</span>}
      </header>

      <section className="balance-card" aria-label="Your savings">
        <span className="balance-label">Your savings</span>
        <p className="balance-amount">{formatMoney(lunaToNimString(total), "NIM").replace(/ NIM$/, "")}<small>NIM</small></p>
        <p className="balance-sub">{balanceSub}</p>
      </section>

      <nav className="quick-actions" aria-label="Quick actions">
        <QuickAction icon="plus" label={g ? "Add" : "Start"} onClick={() => go(g ? "add" : "open")} disabled={wrongNetwork || busy} />
        <QuickAction icon="down" label="Withdraw" onClick={() => go("withdraw")} disabled={wrongNetwork || busy || !g || BigInt(g.active) === 0n} />
        <QuickAction icon="qr" label="My code" onClick={() => onTab("profile")} disabled={!me.code} />
        <QuickAction icon="chat" label="Ask" onClick={onAsk} />
      </nav>

      {messages}

      {due && (
        <section className="card catchup-card" aria-label="Catch-up">
          <span className="card-label">Catch-up</span>
          <strong className="card-title">Save {nim(due.owed)} from last {CATCH_UP_PERIOD[due.every]}'s spending</strong>
          <p className="hint">
            From {dayName(due.from)} to {dayName(due.to - 1)} you spent {nim(due.spent)}. Your {due.spendPercent}% comes to {nim(BigInt(due.owed) + BigInt(due.paid))}
            {BigInt(due.alreadySaved) > 0n ? `, after the ${nim(due.alreadySaved)} apps already saved when you paid them.` : "."}
            {BigInt(due.paid) > 0n ? ` You've added ${nim(due.paid)} since, so ${nim(due.owed)} is left.` : ""}
          </p>
          {!due.complete && <p className="note">Some older payments couldn't be read, so this may be a little low.</p>}
          {paying && paidFor ? (
            <p className="note" role="status">Your {nim(paidFor.luna)} is on its way. It can take a minute to show here.</p>
          ) : due.growOpen ? (
            <button type="button" className="primary" disabled={busy || wrongNetwork} onClick={() => void saveCatchUp()}>{busy ? "Opening Nimiq Pay…" : `Save ${nim(due.owed)}`}</button>
          ) : (
            <p className="note">Open your savings again to save it: they need at least 100 NIM.</p>
          )}
        </section>
      )}

      {g && (released || BigInt(g.retired) > 0n) && (
        <section className="card attention-card">
          <strong className="card-title">{nim(BigInt(g.inactive) + BigInt(g.retired))} is ready to withdraw</strong>
          <p className="hint">Two approvals in Nimiq Pay move it to your wallet.</p>
          <button type="button" className="primary" disabled={busy || wrongNetwork} onClick={() => void finishWithdrawal()}>{busy ? "Opening Nimiq Pay…" : "Finish withdrawal"}</button>
        </section>
      )}
      {g && leaving && <p className="notice" role="status">{nim(g.inactive)} is on its way out of your savings. It's ready in {roughly((g.releaseBlock ?? me.blockNumber) - me.blockNumber)}.</p>}
      {!g && me.code && me.growClosed === "no-stake" && (
        <section className="card attention-card">
          <strong className="card-title">Your savings are closed</strong>
          <p className="hint">Until you open them again, apps that pay your code send everything to your wallet.</p>
          <button type="button" className="primary" disabled={wrongNetwork} onClick={() => go("open")}>Open savings</button>
        </section>
      )}

      {!me.code && (
        <section className="card start-card" aria-label="Get started">
          <h2>Start saving</h2>
          <p className="hint">Games, bounties and shops that pay you NIM can put part of it straight into your savings. You choose how much.</p>
          <ol className="steps">
            <li className={g ? "done" : "now"}>
              <span className="step-mark">{g ? <Icon name="check" size={16} /> : "1"}</span>
              <div className="step-body">
                <strong>Open your savings</strong>
                <p className="hint">{g ? `Open, with ${nim(BigInt(g.active) + BigInt(g.inactive))}.` : "Put in at least 100 NIM. It stays in your own Nimiq account."}</p>
                {!g && me.growClosed === "validator-gone" && <p className="notice">The validator you staked with has closed. Move your stake to another validator in Nimiq Pay, then come back.</p>}
                {!g && me.growClosed !== "validator-gone" && <button type="button" className="primary" disabled={busy || wrongNetwork} onClick={() => go("open")}>Open savings</button>}
              </div>
            </li>
            <li className={g ? "now" : ""}>
              <span className="step-mark">2</span>
              <div className="step-body">
                <strong>Choose your share</strong>
                <p className="hint">How much of what apps pay you goes to savings. Then you get your save code.</p>
                {g && (
                  <>
                    {picker}
                    <button type="button" className="primary" disabled={busy || wrongNetwork} onClick={() => void saveRule({ savePercent: percent, spendPercent: 0, apps: [], catchUp: "weekly" })}>
                      {busy ? "Opening Nimiq Pay…" : "Get my save code"}
                    </button>
                    <p className="note">Nimiq Pay asks you to sign your choice. Signing is free.</p>
                  </>
                )}
              </div>
            </li>
          </ol>
        </section>
      )}

      {draw}

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Recent</h2>
          {me.receipts.length > 0 && <button type="button" className="text-button" onClick={() => onTab("activity")}>See all</button>}
        </div>
        {me.receipts.length === 0 ? (
          <p className="empty">Nothing yet. When an app pays you, or saves for you when you pay it, it shows here.</p>
        ) : (
          <ul className="list">
            {me.receipts.slice(0, RECENT_SHOWN).map((r) => (
              <li key={r.txHash}>
                <div className="row">
                  <span className={`row-icon ${r.kind === "grow" ? "saved" : "in"}`}><Icon name={r.kind === "grow" ? "jar" : "down"} size={20} /></span>
                  <span className="row-main">
                    <strong>{r.app}</strong>
                    <span>{receiptLine(r)}, {shortDay(r.at)}</span>
                  </span>
                  <span className="row-end"><span className="row-amount">+{nim(r.luna)}</span></span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** A round button under the balance, for the things people do most. */
function QuickAction({ icon, label, onClick, disabled }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="quick" onClick={onClick} disabled={disabled}>
      <span className="quick-icon"><Icon name={icon} /></span>
      {label}
    </button>
  );
}

const shortDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
/** What one payment from an app did, in a few words. */
const receiptLine = (r: SaveMe["receipts"][number]) =>
  r.source === "spend" ? (r.kind === "grow" ? "Saved when you paid" : "Your saving, back to your wallet") : r.kind === "grow" ? "Into savings" : "To your wallet";
