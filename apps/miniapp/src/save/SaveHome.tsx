import { init } from "@nimiq/mini-app-sdk";
import type { SaveIntent } from "@railkit/agent";
import type { SaveApp, SaveMe, SaveValidator } from "@railkit/client";
import { checkWithdrawal, formatSaveMessage, lunaToNimString, MIN_STAKE_LUNA, nimStringToLuna, parseNimiqAddress, WalletError, type StakerState } from "@railkit/core";
import { createNimiqSaver } from "@railkit/wallet-nimiq";
import { useEffect, useState, type ReactNode } from "react";
import { formatMoney } from "../format";
import { api, hostNetwork } from "../api";
import { AppBar, Icon, QrCode } from "../ui";

type Mode = "home" | "rule" | "open" | "add" | "withdraw";

const PRESETS = [10, 30, 50, 100];
/** Shares saved on top when paying an app: small, since they're added to the price. */
const SPEND_PRESETS = [0, 5, 10, 20];
/** Payments in shown on Savings; Activity has the rest. */
const PAID_IN_SHOWN = 4;
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
  /** A request from the chat ("put 500 NIM in Grow"): opens the screen for it, filled in. Nothing happens until the user taps. */
  start?: { intent: SaveIntent; notes: string[] } | null;
  /** Called once the request has been opened, so it isn't opened twice. */
  onStarted?: () => void;
  /** Ask Errand, on the main screen. */
  ask?: ReactNode;
  /** The weekly draw's card, on the main screen. It doesn't need a save code. */
  draw?: ReactNode;
  /** Opens Activity, for every payment in. */
  onSeeAll?: () => void;
}

/** The page heading, on the main screens only: the screens inside have a back button instead. */
const HEAD = <header className="home-head"><h1>Savings</h1></header>;

export function SaveHome({ address, start, onStarted, ask, draw, onSeeAll }: Props) {
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
  const [amount, setAmount] = useState("");
  const [validators, setValidators] = useState<SaveValidator[] | null>(null);
  const [validator, setValidator] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
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
      setChosen(m.apps.map((a) => a.name));
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
          setInfo("Grow isn't open yet, so this opens it. Grow starts with at least 100 NIM.");
          setMode("open");
        }
        break;
      case "withdraw":
        if (g && BigInt(g.active) > 0n) {
          setAmount(intent.all ? lunaToNimString(BigInt(g.active)) : intent.nim ?? "");
          setMode("withdraw");
        } else {
          setMode("home");
          setInfo("There's nothing in Grow to withdraw right now.");
        }
        break;
      case "revoke":
        setMode("home");
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

  const go = (m: Mode) => {
    setError(null);
    setInfo(null);
    setAmount(m === "open" ? "100" : "");
    // The rules screen starts from what's saved, not from changes left unsigned last time.
    if (m === "rule" && me) {
      setPercent(me.savePercent ?? 30);
      setSpendPercent(me.spendPercent ?? 0);
      setChosen(me.apps.map((a) => a.name));
    }
    setMode(m);
  };

  // ---- Tap handlers. Each opens Nimiq Pay's own dialog; the signing guard checks they stay that way.

  /** Signs all three rules in one message: the share of payouts, the share on top when paying, and the apps allowed. */
  async function saveRule(rules: { savePercent: number; spendPercent: number; apps: string[] }) {
    if (!self?.ok) return;
    setBusy(true);
    setError(null);
    try {
      const message = formatSaveMessage({ action: "set", address: self.value, ...rules, time: new Date().toISOString(), nonce: newNonce() });
      const saver = createNimiqSaver(await init({ timeout: 5_000 }));
      const signed = await saver.signRule(message);
      await api.saveRule({ message, ...signed });
      await load(true);
      setMode("home");
      setInfo(`Saved. Apps pay ${rules.savePercent}% of what they send you into Grow${rules.spendPercent ? `, and ${rules.spendPercent}% more goes in when you pay one` : ""}.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function openGrow() {
    const luna = nimStringToLuna(amount);
    if (!luna.ok) return setError(luna.error.message);
    if (luna.value < MIN_STAKE_LUNA) return setError("Open Grow with at least 100 NIM. That's Nimiq's minimum for staking.");
    if (!validator) return setError("Choose a validator first.");
    setBusy(true);
    setError(null);
    try {
      const saver = createNimiqSaver(await init({ timeout: 5_000 }));
      await saver.openGrow(validator, luna.value);
      setInfo("Grow is opening. It shows here within a minute.");
      setMode("home");
      const open = await waitFor((m) => m.grow !== null);
      if (open && !me?.code) setInfo("Grow is open. Now choose how much to save and get your save code.");
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
      setInfo(`Adding ${nim(luna.value)} to Grow.`);
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

  if (!self?.ok) return <>{HEAD}<p className="hint">Connecting to Nimiq Pay…</p></>;
  if (!me) {
    return (
      <>
        {HEAD}
        {loadError ? (
          <>
            <p className="alert" role="alert">{loadError}</p>
            <button type="button" className="secondary" onClick={() => void load()}>Try again</button>
          </>
        ) : <p className="hint">Loading your savings…</p>}
      </>
    );
  }

  const wrongNetwork = me.network !== hostNetwork();
  const messages = (
    <>
      {wrongNetwork && <p className="notice" role="status">Errand Save is on Nimiq {me.network}, but Nimiq Pay is on {hostNetwork()}. Switch networks in Nimiq Pay to use savings.</p>}
      {error && <p className="alert" role="alert">{error}</p>}
      {info && <p className="note" role="status">{info}</p>}
    </>
  );
  const example = (p: number) => `If an app pays you 1,000 NIM: ${(p * 10).toLocaleString()} NIM to Grow, ${((100 - p) * 10).toLocaleString()} NIM to your wallet.`;
  const presets = (list: number[], value: number, set: (n: number) => void, label: string, suffix = "") => (
    <div className="presets" role="group" aria-label={label}>
      {(list.includes(value) ? list : [...list, value].sort((a, b) => a - b)).map((p) => (
        <button key={p} type="button" className="preset" aria-pressed={value === p} onClick={() => set(p)}>{p}%{suffix}</button>
      ))}
    </div>
  );
  const picker = (
    <div className="field">
      <span className="field-label">How much of each payment to save</span>
      {presets(PRESETS, percent, setPercent, "Share to save")}
      <p className="hint">{example(percent)}</p>
    </div>
  );

  if (mode === "rule") {
    const toggle = (name: string) => setChosen((c) => (c.includes(name) ? c.filter((n) => n !== name) : [...c, name]));
    // Keep the order of Errand's list, so the signed rule reads the same way every time.
    const allowed = (apps ?? []).map((a) => a.name).filter((n) => chosen.includes(n));
    return (
      <div className="grow">
        <AppBar title="Your saving rules" onBack={() => go("home")} />
        {picker}
        <div className="field">
          <span className="field-label">When you pay an app, save on top</span>
          {presets(SPEND_PRESETS, spendPercent, setSpendPercent, "Share to save when you pay")}
          <p className="hint">
            {spendPercent === 0
              ? "Nothing extra when you pay an app."
              : `Pay an app 100 NIM and you pay ${100 + spendPercent} NIM: ${spendPercent} NIM of it goes into Grow. Only in apps you allow below.`}
          </p>
        </div>
        <div className="field">
          <span className="field-label">Apps that know it's you</span>
          {apps === null ? <p className="hint">Loading apps…</p> : apps.length === 0 ? <p className="hint">No apps save with Errand yet. Give apps your code meanwhile.</p> : (
            <div className="choices">
              {apps.map((a) => (
                <button key={a.id} type="button" className="choice toggle" aria-pressed={chosen.includes(a.name)} onClick={() => toggle(a.name)}>
                  <strong>{a.name}</strong>
                  <small>{chosen.includes(a.name) ? "Saves for you" : "Tap to allow"}</small>
                </button>
              ))}
            </div>
          )}
          <p className="hint">These apps recognise the address they already pay, so you don't need your code there. Other apps can't tell you save with Errand.</p>
        </div>
        {messages}
        <div className="bottom">
          <button type="button" className="primary" disabled={busy || wrongNetwork || apps === null} onClick={() => void saveRule({ savePercent: percent, spendPercent, apps: allowed })}>
            {busy ? "Opening Nimiq Pay…" : "Save my rules"}
          </button>
          <p className="note">Nimiq Pay asks you to sign, so only you can change your rules. It costs nothing.</p>
        </div>
      </div>
    );
  }

  if (mode === "open") {
    return (
      <div className="grow">
        <AppBar title="Open Grow" onBack={() => go("home")} />
        <p className="hint">Grow is NIM you stake from your own account. It earns staking rewards from the validator you pick, and stays yours.</p>
        <div className="field">
          <span className="field-label">Validator</span>
          {validators === null ? <p className="hint">Loading validators…</p> : (
            <div className="choices">
              {validators.slice(0, 8).map((v) => (
                <button key={v.address} type="button" className="choice" aria-pressed={validator === v.address} onClick={() => setValidator(v.address)}>
                  <strong>{v.name ?? shortAddress(v.address)}</strong>
                  <small>{v.numStakers} stakers · {nim(v.stakeLuna)} staked</small>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="field">
          <label htmlFor="save-open-amount">Amount</label>
          <input id="save-open-amount" className="amount-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <p className="hint">At least 100 NIM. You can add more any time.</p>
        </div>
        {messages}
        <div className="bottom">
          <button type="button" className="primary" disabled={busy || wrongNetwork || !validator} onClick={() => void openGrow()}>{busy ? "Opening Nimiq Pay…" : `Open Grow with ${amount || "0"} NIM`}</button>
        </div>
      </div>
    );
  }

  if (mode === "add" || mode === "withdraw") {
    const adding = mode === "add";
    const max = me.grow ? BigInt(me.grow.active) : 0n;
    return (
      <div className="grow">
        <AppBar title={adding ? "Add to Grow" : "Withdraw from Grow"} onBack={() => go("home")} />
        <div className="field">
          <label htmlFor="save-amount">Amount in NIM</label>
          <input id="save-amount" className="amount-input" inputMode="decimal" value={amount} placeholder="0" onChange={(e) => setAmount(e.target.value)} />
          {!adding && (
            <p className="hint">
              You have {nim(max)} in Grow. <button type="button" className="text-button" onClick={() => setAmount(lunaToNimString(max))}>Withdraw all</button>
            </p>
          )}
        </div>
        {!adding && <p className="notice">Withdrawing takes 12 to 24 hours: Nimiq releases staked NIM at the end of an epoch. You finish it here after that, with two approvals in Nimiq Pay.</p>}
        {messages}
        <div className="bottom">
          <button type="button" className="primary" disabled={busy || wrongNetwork || !amount.trim()} onClick={() => void (adding ? addToGrow() : startWithdrawal())}>
            {busy ? "Opening Nimiq Pay…" : adding ? `Add ${amount || "0"} NIM` : `Withdraw ${amount || "0"} NIM`}
          </button>
        </div>
      </div>
    );
  }

  // ---- Home.
  const g = me.grow;
  const total = g ? BigInt(g.active) + BigInt(g.inactive) + BigInt(g.retired) : 0n;
  const released = !!g && BigInt(g.inactive) > 0n && g.releaseBlock !== null && me.blockNumber >= g.releaseBlock;
  const leaving = !!g && BigInt(g.inactive) > 0n && !released;

  if (me.code === null) {
    return (
      <>
        {HEAD}
        <section className="card save-intro">
          <h2>Save a share of every payment</h2>
          <p>Games, bounties and shops that pay you NIM can put part of it straight into your savings. You choose how much.</p>
          <ul className="save-points">
            <li><Icon name="check" size={18} /> Your savings stay in your own Nimiq account, staked so they earn rewards.</li>
            <li><Icon name="check" size={18} /> Apps pay you directly, so Errand never holds your Grow savings.</li>
            <li><Icon name="check" size={18} /> Apps you allow can save for you without your code, and save a little extra when you pay them.</li>
            <li><Icon name="clock" size={18} /> Taking money out takes 12 to 24 hours, so it's never one tap from being spent.</li>
          </ul>
        </section>
        {g ? (
          <>
            <p className="note">Step 2 of 2. Grow is open with {nim(BigInt(g.active) + BigInt(g.inactive))}.</p>
            {picker}
            {messages}
            <button type="button" className="primary" disabled={busy || wrongNetwork} onClick={() => void saveRule({ savePercent: percent, spendPercent: 0, apps: [] })}>{busy ? "Opening Nimiq Pay…" : "Get my save code"}</button>
            <p className="note">Nimiq Pay asks you to sign your choice. Signing costs nothing.</p>
          </>
        ) : (
          <>
            {messages}
            {me.growClosed === "validator-gone" ? (
              <p className="notice">The validator you staked with has closed. Move your stake to another validator in Nimiq Pay, then come back for your save code.</p>
            ) : (
              <>
                <p className="hint">Step 1 of 2: open Grow by staking at least 100 NIM from your own account. Then you choose how much to save and get your code.</p>
                <button type="button" className="primary" disabled={busy || wrongNetwork} onClick={() => go("open")}>Open Grow</button>
              </>
            )}
          </>
        )}
        {draw}
        {ask}
      </>
    );
  }

  return (
    <>
      {HEAD}

      <section className="balance-card" aria-label="Your Grow savings">
        <span className="label"><Icon name="jar" size={18} /> Grow savings</span>
        <p className="balance-amount">{formatMoney(lunaToNimString(total), "NIM").replace(/ NIM$/, "")}<small>NIM</small></p>
        <p className="sub">
          {g ? (g.validatorJailed ? "Your validator is paused, so rewards and withdrawals wait" : "Staked from your own account and earning rewards. Only you can move it.") : me.growClosed === "validator-gone" ? "Your validator has closed. Move your stake in Nimiq Pay." : "Not open yet"}
        </p>
      </section>

      {messages}

      <section className="card code-card" aria-label="Your save code">
        <span className="hint">Your save code</span>
        <p className="save-code">{me.code}</p>
        <p className="hint">Give this code wherever an app asks for your address. Apps you allow below don't need it.</p>
        {showQr && (
          <div className="qr-wrap">
            <QrCode text={me.code} label={`QR code for ${me.code}`} />
            <p className="hint">An app that pays you can scan this instead of typing your code.</p>
          </div>
        )}
        <button type="button" className="secondary" onClick={() => {
          // The clipboard needs HTTPS. Over plain http (a phone on the dev machine's Wi-Fi) there is none, so show the code instead.
          const show = () => setInfo(`Your code is ${me.code}.`);
          if (!navigator.clipboard) return show();
          void navigator.clipboard.writeText(me.code!).then(() => setInfo("Code copied."), show);
        }}>Copy code</button>
        <button type="button" className="text-button" aria-expanded={showQr} onClick={() => setShowQr((v) => !v)}>{showQr ? "Hide QR code" : "Show QR code"}</button>
      </section>

      <section className="card rules-card" aria-label="Your saving rules">
        <strong>Your saving rules</strong>
        <dl className="rules">
          <dt>When an app pays you</dt>
          <dd>{me.savePercent}% into Grow</dd>
          <dt>When you pay an app</dt>
          <dd>{me.spendPercent ? `${me.spendPercent}% more into Grow` : "Nothing extra"}</dd>
          <dt>Apps that know it's you</dt>
          <dd>{me.apps.length ? me.apps.map((a) => a.name).join(", ") : "None yet"}</dd>
        </dl>
        <button type="button" className="secondary" onClick={() => go("rule")}>Change rules</button>
      </section>

      {!g && me.growClosed === "no-stake" && (
        <section className="card">
          <strong>Your Grow savings are closed</strong>
          <p className="hint">Until you open Grow again, apps that pay your code send the whole amount to your wallet. Grow needs at least 100 NIM.</p>
          <button type="button" className="primary" disabled={wrongNetwork} onClick={() => go("open")}>Open Grow</button>
        </section>
      )}

      {g && (
        <nav className="actions" aria-label="Savings actions" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
          <button type="button" className="action" disabled={wrongNetwork || busy} onClick={() => go("add")}><span className="disc"><Icon name="plus" /></span>Add NIM</button>
          <button type="button" className="action" disabled={wrongNetwork || busy || BigInt(g.active) === 0n} onClick={() => go("withdraw")}><span className="disc"><Icon name="down" /></span>Withdraw</button>
        </nav>
      )}

      {g && leaving && (
        <p className="notice" role="status">{nim(g.inactive)} is on its way out. It's ready in {roughly((g.releaseBlock ?? me.blockNumber) - me.blockNumber)}.</p>
      )}
      {g && (released || BigInt(g.retired) > 0n) && (
        <section className="card">
          <strong>{nim(BigInt(g.inactive) + BigInt(g.retired))} is ready to withdraw</strong>
          <button type="button" className="primary" disabled={busy || wrongNetwork} onClick={() => void finishWithdrawal()}>{busy ? "Opening Nimiq Pay…" : "Finish withdrawal"}</button>
        </section>
      )}

      {draw}
      {ask}

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">From apps</h2>
          {me.receipts.length > PAID_IN_SHOWN && onSeeAll && <button type="button" className="text-button" onClick={onSeeAll}>See all</button>}
        </div>
        {me.receipts.length === 0 ? (
          <p className="empty">Nothing yet. When an app pays you, or saves for you when you pay it, it shows here.</p>
        ) : (
          <ul className="list">
            {me.receipts.slice(0, PAID_IN_SHOWN).map((r) => (
              <li key={r.txHash}>
                <div className="row">
                  <span className="row-icon in"><Icon name={r.kind === "grow" ? "jar" : "down"} size={20} /></span>
                  <span className="row-main">
                    <strong>{r.app}</strong>
                    <span>{new Date(r.at).toLocaleDateString(undefined, { day: "numeric", month: "short" })} · {r.source === "spend" ? (r.kind === "grow" ? "saved when you paid" : "your saving, back to your wallet") : r.kind === "grow" ? "to Grow" : "to your wallet"}</span>
                  </span>
                  <span className="row-end"><span className="row-amount">+{nim(r.luna)}</span></span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section">
        {confirmRevoke ? (
          <div className="card">
            <strong>Turn off your save code?</strong>
            <p className="hint">Apps that have it will pay your wallet instead. Your Grow savings stay where they are.</p>
            <div className="row-buttons">
              <button type="button" className="secondary" onClick={() => setConfirmRevoke(false)}>Keep it</button>
              <button type="button" className="primary" disabled={busy || wrongNetwork} onClick={() => void revokeCode()}>Turn off</button>
            </div>
          </div>
        ) : (
          <button type="button" className="text-button" onClick={() => setConfirmRevoke(true)}>Turn off my save code</button>
        )}
      </section>
    </>
  );
}
