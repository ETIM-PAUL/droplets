import { init } from "@nimiq/mini-app-sdk";
import type { PoolMe, PoolStateView } from "@railkit/client";
import { formatPoolWithdrawMessage, formatUsd, lunaToUsd, nimStringToLuna, parseNimiqAddress, parsePrice, parseUsd, WalletError } from "@railkit/core";
import { createNimiqSaver } from "@railkit/wallet-nimiq";
import { useEffect, useState, type ReactNode } from "react";
import { formatMoney } from "../format";
import { api, hostNetwork } from "../api";
import { AppBar } from "../ui";

type Side = "steady" | "boost";
type Mode = "home" | "deposit" | "withdraw";

export const ORDER_STATUS: Record<PoolMe["orders"][number]["status"], string> = {
  awaiting_payment: "Waiting for your payment",
  queued: "Waiting for the next settlement",
  filled: "Done",
  refunded: "Refunded",
  rejected: "Not done",
  expired: "No payment arrived",
};
export const PAYOUT_STATUS: Record<PoolMe["payouts"][number]["status"], string> = { pending: "Paying out soon", sent: "On its way", confirmed: "Paid", failed: "Delayed: Errand is on it" };
export const SIDE_NAME: Record<Side, string> = { steady: "Steady", boost: "Boost" };

const newNonce = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
const when = (ms: number) => {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return `${sameDay ? "today" : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} at ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
};
const errorText = (e: unknown) => {
  if (e instanceof WalletError) {
    if (e.kind === "rejected") return "You cancelled in Nimiq Pay. Nothing changed.";
    if (e.kind === "unknown") return "Nimiq Pay didn't confirm. Check its history before trying again.";
    return e.message;
  }
  return e instanceof Error ? e.message : "Something went wrong. Try again.";
};

/**
 * Steady keeps its dollar value; Boost takes NIM's moves for both sides, for about twice the upside and the
 * downside. Unlike Grow, Errand holds this pool's NIM, so the screen says so, and shows the reserves.
 */
export function PoolHome({ address, head }: { address: string | null; /** The page heading and the Grow / Steady and Boost switch, on the main screen only. */ head?: ReactNode }) {
  const [st, setSt] = useState<PoolStateView | null>(null);
  const [me, setMe] = useState<PoolMe | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("home");
  const [side, setSide] = useState<Side>("steady");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [reserves, setReserves] = useState<Awaited<ReturnType<typeof api.poolReserves>> | null>(null);
  const [showRisks, setShowRisks] = useState(false);

  const self = address ? parseNimiqAddress(address) : null;
  const load = async () => {
    if (!self?.ok) return;
    try {
      const [s, m] = await Promise.all([api.poolState(), api.poolMe(self.value)]);
      setSt(s);
      setMe(m);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  const go = (m: Mode, s: Side = side) => {
    setError(null);
    setInfo(null);
    setAmount("");
    setSide(s);
    setMode(m);
  };

  // ---- Tap handlers. Each opens Nimiq Pay's own dialog; the signing guard checks they stay that way.

  async function depositToPool() {
    if (!self?.ok) return;
    const luna = nimStringToLuna(amount);
    if (!luna.ok) return setError(luna.error.message);
    setBusy(true);
    setError(null);
    try {
      const order = await api.poolDeposit({ address: self.value, side, nim: amount.trim() });
      const saver = createNimiqSaver(await init({ timeout: 5_000 }));
      await saver.payWithMemo(order.poolAddress, BigInt(order.luna), order.memo);
      setMode("home");
      setInfo(`Paid. Your ${formatMoney(order.nim, "NIM")} joins ${SIDE_NAME[side]} at the next settlement, ${when(order.settlesAt)}.`);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function withdrawFromPool() {
    if (!self?.ok) return;
    const text = amount.trim().toLowerCase() === "all" || amount.trim() === "" ? "all" : amount.trim().replace(/^\$/, "");
    if (text !== "all" && (side === "steady" ? parseUsd(text) === null : !nimStringToLuna(text).ok)) {
      return setError(side === "steady" ? "Enter dollars, like 25 or 12.50, or all." : "Enter NIM, with up to 5 decimals, or all.");
    }
    setBusy(true);
    setError(null);
    try {
      const message = formatPoolWithdrawMessage({ address: self.value, side, amount: text, time: new Date().toISOString(), nonce: newNonce() });
      const saver = createNimiqSaver(await init({ timeout: 5_000 }));
      const signed = await saver.signRule(message);
      const r = await api.poolWithdraw({ message, ...signed });
      setMode("home");
      setInfo(`Withdrawal requested. It's paid to your wallet after the next settlement, ${when(r.settlesAt)}.`);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  // ---- Screens.

  if (!self?.ok) return <>{head}<p className="hint">Connecting to Nimiq Pay…</p></>;
  if (!st || !me) {
    return loadError ? (
      <>
        {head}
        <p className="alert" role="alert">{loadError}</p>
        <button type="button" className="secondary" onClick={() => void load()}>Try again</button>
      </>
    ) : <>{head}<p className="hint">Loading Steady and Boost…</p></>;
  }

  const wrongNetwork = st.network !== hostNetwork();
  const blocked = busy || wrongNetwork || st.paused;
  const messages = (
    <>
      {wrongNetwork && <p className="notice" role="status">Steady and Boost run on Nimiq {st.network}, but Nimiq Pay is on {hostNetwork()}. Switch networks in Nimiq Pay to use them.</p>}
      {st.paused && <p className="notice" role="status">Steady and Boost are paused right now. Your balances are safe; new orders wait until they're back.</p>}
      {error && <p className="alert" role="alert">{error}</p>}
      {info && <p className="note" role="status">{info}</p>}
    </>
  );
  const lastPrice = st.settlement ? parsePrice(st.settlement.priceUsd) : 0n;

  if (mode === "deposit" || mode === "withdraw") {
    const depositing = mode === "deposit";
    const luna = nimStringToLuna(amount);
    const estimate = depositing && side === "steady" && luna.ok && lastPrice > 0n ? formatUsd(lunaToUsd(luna.value, lastPrice)) : null;
    return (
      <div className="grow">
        <AppBar title={depositing ? `Add to ${SIDE_NAME[side]}` : `Withdraw from ${SIDE_NAME[side]}`} onBack={() => go("home")} />
        <div className="presets" role="group" aria-label="Steady or Boost">
          {(["steady", "boost"] as const).map((s) => (
            <button key={s} type="button" className="preset" aria-pressed={side === s} onClick={() => setSide(s)}>{SIDE_NAME[s]}</button>
          ))}
        </div>
        <div className="field">
          <label htmlFor="pool-amount">{depositing ? "Amount in NIM" : side === "steady" ? "Amount in dollars, or all" : "Amount in NIM, or all"}</label>
          <input id="pool-amount" className="amount-input" inputMode={depositing ? "decimal" : "text"} value={amount} placeholder={depositing ? "0" : "all"} onChange={(e) => setAmount(e.target.value)} />
          {estimate && <p className="hint">About ${estimate} at the last price. The exact value is set at the next settlement, {when(st.nextSettlementAt)}.</p>}
          {depositing && side === "boost" && <p className="hint">Boost takes NIM's moves for Steady as well, so you gain or lose about {me.boost.leveragePct ? `${me.boost.leveragePct / 100}` : "2"}x what NIM does.</p>}
          {!depositing && <p className="hint">You have {side === "steady" ? `$${me.steady.usd}` : formatMoney(me.boost.nim, "NIM")} in {SIDE_NAME[side]}. It's paid to your wallet after the next settlement.</p>}
        </div>
        {depositing && side === "steady" && st.caps.steadyUsdPerAddress && <p className="note">Pilot limit: up to ${st.caps.steadyUsdPerAddress} in Steady. Anything over it is refunded.</p>}
        {!depositing && side === "boost" && <p className="note">Boost withdrawals can wait while savers in Steady need the cover. They pay out once there's enough.</p>}
        {messages}
        <div className="bottom">
          <button type="button" className="primary" disabled={blocked || (depositing && !amount.trim())} onClick={() => void (depositing ? depositToPool() : withdrawFromPool())}>
            {busy ? "Opening Nimiq Pay…" : depositing ? `Pay ${amount.trim() || "0"} NIM to the pool` : "Request withdrawal"}
          </button>
          <p className="note">{depositing ? "Nimiq Pay shows the pool's address and the order's memo before you approve." : "Nimiq Pay asks you to sign, so only you can withdraw. Signing costs nothing."}</p>
        </div>
      </div>
    );
  }

  const s = st.settlement;
  return (
    <>
      {head}
      <p className="notice">Unlike Grow, Errand holds the NIM you put in Steady and Boost. The reserves check below shows what the pool holds against what it owes.</p>
      {st.network === "testnet" && <p className="note">Pilot on Nimiq testnet.{st.caps.steadyUsdPerAddress ? ` Up to $${st.caps.steadyUsdPerAddress} each in Steady.` : ""}</p>}
      {messages}

      <section className="card pool-side">
        <span className="hint">Steady keeps its dollar value</span>
        <p className="pool-amount">${me.steady.usd}</p>
        <p className="hint">{me.steady.usd === "0.00" ? "Save NIM here and its value is counted in dollars." : `About ${formatMoney(me.steady.nimAtLastPrice, "NIM")} at the last price.`}</p>
        <div className="row-buttons">
          <button type="button" className="secondary" disabled={blocked} onClick={() => go("deposit", "steady")}>Add NIM</button>
          <button type="button" className="secondary" disabled={blocked || me.steady.usd === "0.00"} onClick={() => go("withdraw", "steady")}>Withdraw</button>
        </div>
      </section>

      <section className="card pool-side">
        <span className="hint">Boost takes NIM's moves for both sides</span>
        <p className="pool-amount">{formatMoney(me.boost.nim, "NIM")}</p>
        <p className="hint">{s?.boostLeveragePct ? `Right now that's about ${s.boostLeveragePct / 100}x NIM's ups and downs.` : "About 2x NIM's ups and downs when both sides are the same size."}</p>
        <div className="row-buttons">
          <button type="button" className="secondary" disabled={blocked} onClick={() => go("deposit", "boost")}>Add NIM</button>
          <button type="button" className="secondary" disabled={blocked || me.boost.nim === "0"} onClick={() => go("withdraw", "boost")}>Withdraw</button>
        </div>
      </section>

      <section className="card">
        <dl className="ledger">
          <dt>Next settlement</dt><dd>{when(st.nextSettlementAt)}</dd>
          {s && <><dt>Last price</dt><dd>${s.priceUsd} per NIM</dd></>}
          {s && <><dt>Steady's cover</dt><dd>{s.coverBps === null ? "No savers yet" : `${Math.floor(s.coverBps / 100)}%`}</dd></>}
          <dt>Fee</dt><dd>{st.feeBpsPerYear / 100}% a year</dd>
        </dl>
        <button type="button" className="text-button" aria-expanded={showRisks} onClick={() => setShowRisks((v) => !v)}>{showRisks ? "Hide how it works" : "How it works, and the risks"}</button>
        {showRisks && (
          <ul className="save-points">
            <li>Balances change once a day, at the settlement. Deposits and withdrawals happen then too, at that day's price.</li>
            <li>Steady is protected while Boost has enough NIM to cover it. If NIM falls further than that in one day, Steady shares what's in the pool and Boost loses everything.</li>
            <li>Boost withdrawals can wait while savers in Steady need the cover.</li>
          </ul>
        )}
        {reserves ? (
          <p className="hint">The pool holds {formatMoney(reserves.onChainNim, "NIM")} on-chain and owes {formatMoney(reserves.owedNim, "NIM")}: {reserves.covered ? "fully covered" : "not covered, and Errand has been alerted"}.</p>
        ) : (
          <button type="button" className="text-button" onClick={() => void api.poolReserves().then(setReserves, (e) => setError(errorText(e)))}>Check the reserves</button>
        )}
      </section>

      {(me.orders.length > 0 || me.payouts.length > 0) && (
        <section className="section">
          <h2 className="section-title">Your orders</h2>
          <ul className="list">
            {me.orders.map((o) => {
              const payout = me.payouts.find((p) => p.orderId === o.id);
              const what = o.kind === "deposit" ? `Added ${o.nim ? formatMoney(o.nim, "NIM") : ""}` : `Withdraw ${o.all ? "all" : o.usd ? `$${o.usd}` : o.nim ? formatMoney(o.nim, "NIM") : ""}`;
              return (
                <li key={o.id}>
                  <div className="row">
                    <span className="row-main">
                      <strong>{SIDE_NAME[o.side]}: {what}</strong>
                      <span>{payout ? `${PAYOUT_STATUS[payout.status]} · ${formatMoney(payout.nim, "NIM")}` : ORDER_STATUS[o.status]}{o.note ? `. ${o.note}` : ""}</span>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}
