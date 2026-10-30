import type { RampOffer, RampState } from "@railkit/adapters/server";
import type { TopupIntent } from "@railkit/agent";
import { parseNimiqAddress, type CountryCode } from "@railkit/core";
import { useEffect, useState } from "react";
import { formatMoney } from "../format";
import { api } from "../send/engine";
import { deviceId, topupBook, type LocalTopup } from "../storage";
import { AppBar, Icon } from "../ui";

interface Props {
  /** The user's Nimiq Pay accounts; NIM goes to the one they pick. */
  accounts: { address: string; nim: string }[];
  /** From the chat: "add ₦10,000" or "buy 100 NIM". */
  prefill?: TopupIntent;
  /** From Activity: open this top-up's tracker. */
  openOrderId?: string;
  onHome: () => void;
}

/** A sample amount per currency, used to price "buy N NIM" before the real offers. */
const PROBE: Record<string, string> = { NGN: "20000", KES: "2000", GHS: "200", ZAR: "300" };

const book = topupBook();

const PROVIDER_NAMES: Record<string, string> = { moonpay: "MoonPay", banxa: "Banxa", wert: "Wert", mercuryo: "Mercuryo", transak: "Transak", ramp: "Ramp", simplex: "Simplex" };
const providerName = (code: string) => PROVIDER_NAMES[code] ?? code.charAt(0).toUpperCase() + code.slice(1);

const STATE_TEXT: Record<RampState, string> = {
  awaiting_payment: "Waiting for your payment",
  processing: "Payment received. Sending your NIM",
  hold: "On hold: the provider needs something from you",
  completed: "NIM arrived",
  failed: "Didn't go through",
};

type Step = { name: "amount" } | { name: "offers"; offers: RampOffer[]; notes: string[] } | { name: "confirm"; offer: RampOffer; method?: string } | { name: "track"; topup: LocalTopup };

/**
 * Add money: the user picks an amount, compares providers, and pays on the provider's own page. The provider
 * checks their ID and sends NIM straight to their Nimiq Pay address. Errand never touches the money.
 */
export function AddMoney({ accounts, prefill, openOrderId, onHome }: Props) {
  const [countries, setCountries] = useState<{ country: CountryCode; currency: string }[] | null>(null);
  const [country, setCountry] = useState<CountryCode | null>(null);
  // Default to the account the user actually uses: the one holding the most NIM.
  const [address, setAddress] = useState(() => [...accounts].sort((a, b) => Number(b.nim) - Number(a.nim))[0]?.address ?? "");
  const [amount, setAmount] = useState(prefill?.amount ?? "");
  const [step, setStep] = useState<Step>(() => {
    const t = openOrderId ? book.list().find((x) => x.orderId === openOrderId) : undefined;
    return t ? { name: "track", topup: t } : { name: "amount" };
  });
  const [estimate, setEstimate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [history, setHistory] = useState<LocalTopup[]>(() => book.list());

  useEffect(() => {
    api.topupOptions().then(
      (c) => {
        setCountries(c);
        const chosen = c.find((x) => x.currency === prefill?.currency) ?? c[0];
        setCountry(chosen?.country ?? null);
        // From the chat with an amount: go straight to the offers.
        if (chosen && step.name === "amount" && parseNimiqAddress(address).ok) {
          if (prefill?.nim) void priceNim(prefill.nim, chosen.country, chosen.currency);
          else if (prefill?.amount) void getOffers(prefill.amount, chosen.country);
        }
      },
      (e: Error) => {
        setCountries([]);
        setError(e.message);
      },
    );
  }, []);

  const currency = countries?.find((c) => c.country === country)?.currency ?? "";
  const addressOk = parseNimiqAddress(address).ok;

  /**
   * "buy 100 NIM": providers price in fiat, so price a sample amount, scale it to the NIM wanted with a small
   * margin for fees, then fetch real offers for that. Shown as an estimate, never as a promise.
   */
  async function priceNim(nim: string, c: CountryCode, cur: string) {
    setError(null);
    setBusy(true);
    try {
      const probe = await api.topupOffers({ country: c, amount: PROBE[cur] ?? "10000", walletAddress: address });
      const best = probe.offers[0];
      if (!best || Number(best.amountExpectedTo) <= 0) {
        setBusy(false);
        return setError(probe.errors[0]?.message ?? "Errand couldn't price NIM right now. Enter an amount to pay instead.");
      }
      const perFiat = Number(best.amountExpectedTo) / Number(PROBE[cur] ?? "10000");
      const fiat = String(Math.ceil((Number(nim) / perFiat) * 1.03));
      setAmount(fiat);
      setEstimate(`About ${formatMoney(fiat, cur)} buys ${formatMoney(nim, "NIM")}. The provider's final amount can differ a little.`);
      await getOffers(fiat, c);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function getOffers(amt = amount.trim(), c = country) {
    if (!c) return;
    setError(null);
    setBusy(true);
    try {
      const r = await api.topupOffers({ country: c, amount: amt, walletAddress: address });
      if (r.offers.length === 0) {
        setError(r.errors[0]?.message ?? "No provider can take this top-up right now. Try a different amount, or try again later.");
      } else {
        setStep({ name: "offers", offers: r.offers, notes: [...new Set(r.errors.map((e) => `${providerName(e.providerCode)}: ${e.message}`))] });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function goPay(offer: RampOffer, method?: string) {
    if (!country || !agreed) return;
    setError(null);
    setBusy(true);
    try {
      const r = await api.createTopup({ country, amount: amount.trim(), walletAddress: address, providerCode: offer.providerCode, paymentMethod: method, userId: deviceId() });
      const chosen = offer.methods.find((m) => m.method === method);
      const topup: LocalTopup = {
        orderId: r.orderId, provider: offer.providerCode, amount: amount.trim(), currency, expectedNim: chosen?.amountExpectedTo ?? offer.amountExpectedTo,
        address, redirectUrl: r.redirectUrl, createdAt: Date.now(), state: "awaiting_payment",
      };
      book.put(topup);
      setHistory(book.list());
      setStep({ name: "track", topup });
      openProvider(r.redirectUrl);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (step.name === "track") return <TopupTracker topup={step.topup} onHome={onHome} onUpdate={() => setHistory(book.list())} />;

  return (
    <div className="screen">
      <AppBar
        title={step.name === "offers" ? "Choose an offer" : step.name === "confirm" ? "Confirm" : "Add money"}
        onBack={step.name === "amount" ? onHome : () => { setStep({ name: "amount" }); setAgreed(false); }}
        backLabel={step.name === "amount" ? "Cancel" : "Back"}
      />

      <div className="grow">
        {countries?.length === 0 && !error && <p className="hint">Adding money isn't available in your country yet.</p>}

        {step.name === "amount" && countries && countries.length > 0 && (
          <form className="grow" onSubmit={(e) => { e.preventDefault(); void getOffers(); }}>
            {countries.length > 1 && (
              <div className="choices">
                {countries.map((c) => (
                  <button key={c.country} type="button" className="choice" aria-pressed={c.country === country} onClick={() => setCountry(c.country)}>
                    Pay in {c.currency}
                  </button>
                ))}
              </div>
            )}
            <div className="field">
              <label htmlFor="topup-amount">How much do you want to pay, in {currency}?</label>
              <input id="topup-amount" className="amount-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} autoFocus />
            </div>
            <div className="field">
              <label htmlFor="topup-to">NIM goes to</label>
              {accounts.length > 1 ? (
                <select id="topup-to" value={address} onChange={(e) => setAddress(e.target.value)}>
                  {accounts.map((a, i) => <option key={a.address} value={a.address}>Account {i + 1}: {a.address.slice(0, 9)}…{a.address.slice(-4)} ({formatMoney(a.nim, "NIM")})</option>)}
                </select>
              ) : accounts.length === 1 ? (
                <p className="hint">{accounts[0]!.address}</p>
              ) : (
                <input id="topup-to" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="NQ.. .... ...." autoComplete="off" spellCheck={false} />
              )}
            </div>
            {error && <p className="alert" role="alert">{error}</p>}
            <div className="grow" />
            <button className="primary" disabled={busy || !amount.trim() || !addressOk}>{busy ? "Finding offers…" : "See offers"}</button>
          </form>
        )}

        {step.name === "offers" && (
          <>
            {estimate && <p className="notice">{estimate}</p>}
            <p className="hint">You pay {formatMoney(amount, currency)}. Best offer first.</p>
            <div className="choices">
              {step.offers
                .flatMap((o) => (o.methods.length ? o.methods : [{ method: "", methodName: "", amountExpectedTo: o.amountExpectedTo, fee: o.fee }]).map((m) => ({ o, m })))
                // Every provider and payment method in one list, most NIM first.
                .sort((a, b) => Number(b.m.amountExpectedTo) - Number(a.m.amountExpectedTo))
                .map(({ o, m }, i) => (
                  <button key={`${o.providerCode}:${m.method}`} type="button" className="choice" onClick={() => setStep({ name: "confirm", offer: o, method: m.method || undefined })}>
                    <span>You get about {formatMoney(m.amountExpectedTo, "NIM")} {i === 0 && <span className="status ok">Best</span>}</span>
                    <small>{providerName(o.providerCode)}{m.methodName ? `, ${m.methodName.toLowerCase()}` : ""}. Fee {formatMoney(m.fee, currency)}</small>
                  </button>
                ))}
            </div>
            {step.notes.map((n) => <p key={n} className="note">{n}</p>)}
          </>
        )}

        {step.name === "confirm" && (
          <>
            <section className="card">
              <p className="question">{providerName(step.offer.providerCode)} takes your payment</p>
              <p className="hint">You pay {formatMoney(amount, currency)} on {providerName(step.offer.providerCode)}'s own page, and they send about {formatMoney(step.offer.methods.find((m) => m.method === step.method)?.amountExpectedTo ?? step.offer.amountExpectedTo, "NIM")} to:</p>
              <p className="hint">{parseNimiqAddress(address).ok ? (parseNimiqAddress(address) as { value: string }).value : address}</p>
              <p className="note">{providerName(step.offer.providerCode)} checks your identity (KYC) the first time, as the law requires. Errand never sees your card or bank details and never holds your money.</p>
            </section>
            <label className="consent">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              <span>I agree to {providerName(step.offer.providerCode)}'s terms and identity checks.</span>
            </label>
            {error && <p className="alert" role="alert">{error}</p>}
            <div className="grow" />
            <button className="primary" disabled={busy || !agreed} onClick={() => void goPay(step.offer, step.method)}>
              {busy ? "Opening…" : `Continue to ${providerName(step.offer.providerCode)}`}
            </button>
          </>
        )}

        {step.name === "amount" && history.length > 0 && (
          <section>
            <h2 className="section-title">Your top-ups</h2>
            <ul className="list">
              {history.slice(0, 5).map((t) => (
                <li key={t.orderId}>
                  <button type="button" onClick={() => setStep({ name: "track", topup: t })}>
                    <span>{formatMoney(t.amount, t.currency)} via {providerName(t.provider)}</span>
                    <span className={`status ${t.state === "completed" ? "ok" : t.state === "failed" || t.state === "hold" ? "bad" : ""}`}>{STATE_TEXT[t.state as RampState] ?? "Checking"}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

/** A new tab where the host allows one; otherwise this page goes to the provider and the tracker picks up on return. */
function openProvider(url: string) {
  const w = window.open(url, "_blank", "noopener");
  if (!w) window.location.assign(url);
}

function TopupTracker({ topup, onHome, onUpdate }: { topup: LocalTopup; onHome: () => void; onUpdate: () => void }) {
  const [state, setState] = useState<RampState>((topup.state as RampState) ?? "awaiting_payment");
  const [payout, setPayout] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        const s = await api.topupStatus(topup.orderId);
        if (stop) return;
        setState(s.state);
        setPayout(s.payoutAmount);
        setError(null);
        book.put({ ...topup, state: s.state });
        onUpdate();
        if (s.state === "completed" || s.state === "failed") return;
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
      if (!stop) setTimeout(tick, 10_000);
    }
    void tick();
    return () => { stop = true; };
    // One tracker per order.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topup.orderId]);

  const steps: { label: string; done: boolean; now: boolean }[] = [
    { label: `Pay ${formatMoney(topup.amount, topup.currency)} on ${providerName(topup.provider)}'s page`, done: state !== "awaiting_payment", now: state === "awaiting_payment" },
    { label: `${providerName(topup.provider)} sends your NIM`, done: state === "completed", now: state === "processing" || state === "hold" },
    { label: "NIM arrives in Nimiq Pay", done: state === "completed", now: false },
  ];

  return (
    <div className="screen">
      <AppBar title="Add money" onBack={onHome} backLabel="Home" />
      <div className="result">
        <span className={`result-icon${state === "completed" ? " ok" : state === "failed" || state === "hold" ? " bad" : ""}`}>
          <Icon name={state === "completed" ? "check" : state === "failed" ? "close" : "clock"} size={30} />
        </span>
        <p className="arrived-amount">{state === "completed" ? "+" : ""}{formatMoney(payout ?? topup.expectedNim, "NIM")}</p>
        <p className="question">{state === "completed" ? "arrived in Nimiq Pay" : STATE_TEXT[state]}</p>
        <p className="note">{new Date(topup.createdAt).toLocaleString()}</p>
      </div>

      <div className="grow">
        <ol className="timeline">
          {steps.map((s) => <li key={s.label} className={s.done ? "done" : s.now ? "now" : ""}>{s.label}</li>)}
        </ol>
        {state === "hold" && <p className="alert" role="alert">{providerName(topup.provider)} has paused this, usually to check your ID. Open their page to see what they need.</p>}
        {state === "failed" && <p className="alert" role="alert">This top-up didn't go through. If money left your account, {providerName(topup.provider)} refunds it. Contact them with order {topup.orderId}.</p>}
        {error && <p className="note">{error}</p>}
        <div className="grow" />
        {(state === "awaiting_payment" || state === "hold") && (
          <button className="primary" onClick={() => openProvider(topup.redirectUrl)}>Open {providerName(topup.provider)}'s page</button>
        )}
        <p className="note">Order {topup.orderId}. NIM goes to {topup.address}.</p>
      </div>
    </div>
  );
}
