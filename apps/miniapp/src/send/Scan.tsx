import { init } from "@nimiq/mini-app-sdk";
import { describePayment, explainRoute, nonPaymentKind, resolvePaymentText, type ParsedPayment, type PaymentSummary, type Quote } from "@railkit/core";
import { createNimiqExecutor } from "@railkit/wallet-nimiq";
import QrScanner from "qr-scanner";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatCountdown, formatMoney } from "../format";
import { AppBar } from "../ui";
import { api, hostNetwork, PRACTICE, sendEngine } from "./engine";

interface Props {
  enabled: ReadonlySet<string>;
  onDone: (orderId: string) => void;
  onCancel: () => void;
}

interface Found {
  payment: ParsedPayment;
  summary: PaymentSummary;
  /** Found by the assistant rather than the offline parsers: say so. */
  byModel: boolean;
}

/**
 * Scan or paste a payment code. The phone's own parsers read it first; only text they can't read goes to
 * Errand's server (and maybe the model), whose answer is parsed again before it's shown. Nothing is paid
 * until the user sees the price and the route, taps Pay, and approves in Nimiq Pay.
 */
export function Scan({ enabled, onDone, onCancel }: Props) {
  const [text, setText] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sats, setSats] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [armedAt, setArmedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const file = useRef<HTMLInputElement>(null);
  const engine = useMemo(() => sendEngine(enabled), [enabled]);

  useEffect(() => {
    if (!quote) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [quote]);

  const reset = () => {
    setFound(null);
    setInfo(null);
    setError(null);
    setQuote(null);
    setSats("");
  };

  async function read(raw: string) {
    reset();
    const t = raw.trim();
    if (!t) return;
    const local = resolvePaymentText(t);
    if (local.status === "found") return setFound({ payment: local.payment, summary: describePayment(local.payment, Date.now(), hostNetwork()), byModel: false });
    if (local.status === "ambiguous") return setError("This code holds more than one payment request. Ask the recipient for a code with just one.");
    // Wi-Fi codes, contacts and links are named here, so their contents never leave the phone.
    const plain = nonPaymentKind(t);
    if (plain) return setInfo(`This isn't a payment code. It looks like ${plain}. Errand can pay Lightning invoices, Lightning Addresses and LNURL codes.`);
    setBusy(true);
    try {
      const r = await api.understandQr(t, hostNetwork());
      if (r.status === "found" && r.payment) {
        setFound({ payment: r.payment, summary: describePayment(r.payment, Date.now(), hostNetwork()), byModel: r.source === "model" });
      } else if (r.status === "ambiguous") {
        setError("This code holds more than one payment request. Ask the recipient for a code with just one.");
      } else {
        setInfo(`This isn't a payment code${r.what ? `. It looks like ${r.what.replace(/\.$/, "")}` : ""}. Errand can pay Lightning invoices, Lightning Addresses and LNURL codes.`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function fromPhoto(f: File | undefined) {
    if (!f) return;
    reset();
    setBusy(true);
    try {
      const r = await QrScanner.scanImage(f, { returnDetailedScanResult: true });
      setText(r.data);
      setBusy(false);
      await read(r.data);
    } catch {
      setBusy(false);
      setError("Errand couldn't find a QR code in that photo. Fill the frame with the code and try again, or paste it below.");
    } finally {
      if (file.current) file.current.value = "";
    }
  }

  async function getPrice() {
    if (!found) return;
    setError(null);
    setBusy(true);
    const amount = found.summary.needsAmount ? { amount: sats.trim(), currency: "SAT" } : undefined;
    const r = await engine.quote({ kind: "pay", destination: found.payment, amount, sourceAsset: "NIM" });
    setBusy(false);
    if (!r.ok) return setError(r.error.message);
    setNow(Date.now());
    setArmedAt(Date.now() + 1_500);
    setQuote(r.value[0]!);
  }

  async function pay() {
    if (!quote || Date.now() < armedAt) return;
    if (Date.now() >= quote.expiresAt) return setError("This price has expired. Get a new price to see the current one.");
    setBusy(true);
    setError(null);
    const created = await engine.createOrder(quote);
    if (!created.ok) {
      setBusy(false);
      setQuote(null);
      return setError(created.error.message);
    }
    try {
      const pending = engine.approve(created.value.id, createNimiqExecutor(await init({ timeout: 5_000 })));
      onDone(created.value.id);
      await pending;
    } catch {
      setBusy(false);
      setError("Errand couldn't reach your wallet. Close and reopen Errand, then try again.");
    }
  }

  const expiresIn = quote ? quote.expiresAt - now : 0;

  return (
    <div className="screen">
      <AppBar title="Pay a code" onBack={onCancel} backLabel="Cancel" />

      <div className="grow">
        {!found && (
          <>
            <input ref={file} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void fromPhoto(e.target.files?.[0])} />
            <button type="button" className="primary" disabled={busy} onClick={() => file.current?.click()}>Take a photo of the QR code</button>
            <form className="field" onSubmit={(e) => { e.preventDefault(); void read(text); }}>
              <label htmlFor="code">Or paste a Lightning invoice, Lightning Address or LNURL</label>
              <textarea id="code" className="code-input" rows={3} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false} />
              <button className="secondary" disabled={busy || !text.trim()}>{busy ? "Reading…" : "Read it"}</button>
            </form>
          </>
        )}

        {info && <p className="hint" role="status">{info}</p>}

        {found && (
          <section className="card">
            <p className="question">{found.summary.title}</p>
            {found.summary.details.map((d) => <p key={d} className="hint">{d}</p>)}
            {found.byModel && <p className="note">Errand's assistant found this inside the code. Check it's who you meant to pay.</p>}
            {!found.summary.payable && <p className="alert" role="alert">{found.summary.why}</p>}
          </section>
        )}

        {found?.summary.payable && PRACTICE && <p className="hint">Practice mode covers bank and mobile money payouts only. Lightning payments are always real.</p>}

        {found?.summary.payable && !PRACTICE && !quote && (
          <form className="grow" onSubmit={(e) => { e.preventDefault(); void getPrice(); }}>
            {found.summary.needsAmount && (
              <div className="field">
                <label htmlFor="sats">How many sats?</label>
                <input id="sats" className="amount-input" inputMode="numeric" value={sats} onChange={(e) => setSats(e.target.value.replace(/\D/g, ""))} autoFocus />
              </div>
            )}
            {error && <p className="alert" role="alert">{error}</p>}
            <div className="grow" />
            <button className="primary" disabled={busy || (!!found.summary.needsAmount && !sats)}>{busy ? "Getting the price…" : "See the price"}</button>
          </form>
        )}

        {quote && (
          <>
            <dl className="ledger">
              <dt>They get</dt>
              <dd className="total">{formatMoney(quote.receive.amount, "sats")}</dd>
              <dt>Price holds for</dt>
              <dd>{expiresIn > 0 ? formatCountdown(expiresIn) : "expired"}</dd>
            </dl>
            <section className="card">
              <h2 className="section-title">How it gets there</h2>
              {explainRoute(quote).map((l) => <p key={l} className="note">{l}</p>)}
              {quote.notes?.map((n) => <p key={n} className="note">{n}</p>)}
            </section>
            {error && <p className="alert" role="alert">{error}</p>}
            <div className="grow" />
            {expiresIn > 0 ? (
              <button className="primary" disabled={busy || now < armedAt} onClick={() => void pay()}>
                {busy ? "Opening Nimiq Pay…" : `Pay ${formatMoney(quote.receive.amount, "sats")}`}
              </button>
            ) : (
              !busy && <button className="secondary" onClick={() => void getPrice()}>Get a new price</button>
            )}
          </>
        )}

        {found && !quote && !busy && <button type="button" className="secondary" onClick={() => { reset(); setText(""); }}>Scan a different code</button>}
        {!found && error && <p className="alert" role="alert">{error}</p>}
      </div>
    </div>
  );
}
