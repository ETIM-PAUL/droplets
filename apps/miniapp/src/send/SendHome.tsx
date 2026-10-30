import { init } from "@nimiq/mini-app-sdk";
import { CORRIDORS, validatePayoutAmount, validateRecipient, type Corridor, type CorridorId, type PayoutRecipient, type Quote } from "@railkit/core";
import { createNimiqExecutor } from "@railkit/wallet-nimiq";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatCountdown, formatMoney } from "../format";
import { recipientBook, type SavedRecipient } from "../storage";
import { api, PRACTICE, practiceWallet, sendEngine } from "./engine";
import { Sentence, type Step } from "./Sentence";

interface Props {
  enabled: Corridor[];
  start?: SavedRecipient;
  onDone: (orderId: string) => void;
  onCancel: () => void;
}

const book = recipientBook();

export function SendHome({ enabled, start, onDone, onCancel }: Props) {
  const [corridorId, setCorridorId] = useState<CorridorId | null>(start?.corridor ?? (enabled.length === 1 ? enabled[0]!.id : null));
  const [phone, setPhone] = useState(start?.recipient.type === "mobile-money" ? start.recipient.phone : "");
  const [name, setName] = useState(start ? (start.recipient.type === "mobile-money" ? start.recipient.name : start.recipient.accountName) : "");
  const [bank, setBank] = useState<{ name: string; code: string } | null>(
    start?.recipient.type === "bank" ? { name: start.recipient.bankName, code: start.recipient.bankCode ?? "" } : null,
  );
  const [account, setAccount] = useState(start?.recipient.type === "bank" ? start.recipient.accountNumber : "");
  const [amount, setAmount] = useState(start?.lastAmount ?? "");
  const [step, setStep] = useState<Step>(start ? "amount" : corridorId ? "who" : "where");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [now, setNow] = useState(Date.now());
  const [banks, setBanks] = useState<{ name: string; code: string }[]>([]);
  // After a price appears, Send stays off briefly so a tap meant for something else can't send it.
  const [armedAt, setArmedAt] = useState(0);
  const [requoted, setRequoted] = useState(false);
  const nameChecked = useRef("");

  const corridor = corridorId ? CORRIDORS[corridorId] : null;
  const engine = useMemo(() => sendEngine(new Set(enabled.map((c) => c.id))), [enabled]);

  const recipient = (): PayoutRecipient | null => {
    if (!corridor) return null;
    return corridor.recipientType === "mobile-money"
      ? { type: "mobile-money", phone, name, network: corridor.network! }
      : { type: "bank", bankCode: bank?.code, bankName: bank?.name ?? "", accountNumber: account, accountName: name };
  };

  // Nigerian banks: load the list, and look up the account holder's name once the number is complete.
  useEffect(() => {
    if (corridor?.country === "NG" && banks.length === 0) api.banks().then(setBanks, () => setError("Couldn't load the list of banks. Check your connection."));
  }, [corridor, banks.length]);
  useEffect(() => {
    if (corridor?.country !== "NG") return;
    const key = `${bank?.code}:${account}`;
    if (nameChecked.current === key) return;
    // Any change to the bank or number makes the old name wrong: clear it before anything else.
    nameChecked.current = key;
    setName("");
    if (!bank?.code || !/^\d{10}$/.test(account)) return;
    api.nameEnquiry(account, bank.code).then(
      (r) => nameChecked.current === key && setName(r.accountName),
      (e: Error) => nameChecked.current === key && setError(e.message),
    );
  }, [corridor, bank, account]);

  useEffect(() => {
    if (!quote) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [quote]);

  const go = (s: Step) => {
    setError(null);
    setQuote(null);
    setStep(s);
  };

  function nextFromWho() {
    const r = recipient();
    if (!r || !corridorId) return;
    const v = validateRecipient(corridorId, r);
    if (!v.ok) return setError(v.error.message);
    if (v.value.type === "mobile-money") setPhone(v.value.phone);
    go("amount");
  }

  async function getQuote() {
    if (!corridor || !corridorId) return;
    const a = validatePayoutAmount(corridorId, { amount: amount.trim(), currency: corridor.currency });
    if (!a.ok) return setError(a.error.message);
    setBusy(true);
    setError(null);
    setRequoted(quote !== null);
    setQuote(null);
    setStep("review");
    const r = await engine.quote({ kind: "pay", destination: { kind: "fiat-payout", corridor: corridorId, recipient: recipient()! }, sourceAsset: "NIM", amount: a.value });
    setBusy(false);
    if (!r.ok) {
      setStep("amount");
      return setError(r.error.message);
    }
    setNow(Date.now());
    setArmedAt(Date.now() + 1_500);
    setQuote(r.value[0]!);
  }

  async function send() {
    if (!quote || !corridorId || Date.now() < armedAt) return;
    if (Date.now() >= quote.expiresAt) {
      setError("This price has expired. Get a new price to see the current one.");
      return;
    }
    setBusy(true);
    setError(null);
    const created = await engine.createOrder(quote);
    if (!created.ok) {
      setBusy(false);
      setQuote(null);
      return setError(created.error.message);
    }
    try {
      const orderRef = quote.providerRef?.replace(/^payout:/, "") ?? "";
      const wallet = PRACTICE ? practiceWallet(orderRef) : createNimiqExecutor(await init({ timeout: 5_000 }));
      // Show the order screen at once; approval and tracking continue there.
      const pending = engine.approve(created.value.id, wallet);
      book.remember({ corridor: corridorId, recipient: quote.intent.destination.kind === "fiat-payout" ? quote.intent.destination.recipient : recipient()!, lastAmount: amount.trim(), usedAt: Date.now() });
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
      <div className="topbar">
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
      <Sentence corridor={corridor} name={name} amount={amount} step={step} onEdit={busy ? undefined : go} />

      <div className="grow">
        {step === "where" && (
          <>
            <p className="question">Where does the money go?</p>
            <div className="choices">
              {enabled.map((c) => (
                <button key={c.id} type="button" className="choice" aria-pressed={c.id === corridorId}
                  onClick={() => { setCorridorId(c.id); go("who"); }}>
                  {c.label.split(": ")[1]}
                  <small>{c.label.split(": ")[0]}, {c.currency}</small>
                </button>
              ))}
              {enabled.length === 0 && <p className="hint">Sending is paused right now. Try again later.</p>}
            </div>
          </>
        )}

        {step === "who" && corridor && (
          <form className="grow" onSubmit={(e) => { e.preventDefault(); nextFromWho(); }}>
            <p className="question">Who gets it?</p>
            {corridor.recipientType === "mobile-money" ? (
              <>
                <div className="field">
                  <label htmlFor="phone">Their {corridor.label.split(": ")[1]} number</label>
                  <input id="phone" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={corridor.country === "KE" ? "0712 345 678" : ""} />
                </div>
                <div className="field">
                  <label htmlFor="name">Their name, as it shows on {corridor.label.split(": ")[1]}</label>
                  <input id="name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
              </>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="bank">Their bank</label>
                  <input id="bank" list="banks" value={bank?.name ?? ""} onChange={(e) => setBank(banks.find((b) => b.name === e.target.value) ?? { name: e.target.value, code: "" })} />
                  <datalist id="banks">{banks.map((b) => <option key={b.code} value={b.name} />)}</datalist>
                </div>
                <div className="field">
                  <label htmlFor="account">Account number</label>
                  <input id="account" inputMode="numeric" value={account} onChange={(e) => setAccount(e.target.value.replace(/\D/g, ""))} />
                </div>
                {corridor.country === "NG"
                  ? name && <p className="hint">Account holder: <strong>{name}</strong></p>
                  : (
                    <div className="field">
                      <label htmlFor="holder">Account holder's name</label>
                      <input id="holder" value={name} onChange={(e) => setName(e.target.value)} />
                    </div>
                  )}
              </>
            )}
            {error && <p className="alert" role="alert">{error}</p>}
            <div className="grow" />
            <button className="primary" disabled={!name.trim()}>Continue</button>
          </form>
        )}

        {step === "amount" && corridor && (
          <form className="grow" onSubmit={(e) => { e.preventDefault(); void getQuote(); }}>
            <p className="question">How much should {name || "they"} get?</p>
            <div className="field">
              <label htmlFor="amount">Amount in {corridor.currency}</label>
              <input id="amount" className="amount-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} autoFocus />
            </div>
            {corridor.minAmount && <p className="hint">At least {formatMoney(corridor.minAmount, corridor.currency)}.</p>}
            {error && <p className="alert" role="alert">{error}</p>}
            <div className="grow" />
            <button className="primary" disabled={!amount.trim() || busy}>See the price</button>
          </form>
        )}

        {step === "review" && corridor && (
          <>
            {busy && !quote && <p className="hint">Getting the best price…</p>}
            {quote && (
              <>
                <dl className="ledger">
                  <dt>{name} gets</dt>
                  <dd className="total">{formatMoney(quote.receive.amount, quote.receive.currency)}</dd>
                  <dt>You pay</dt>
                  <dd className="total">{formatMoney(quote.send.amount, "sats")}</dd>
                  <dt>Payout fee, included</dt>
                  <dd>{formatMoney(quote.fee.amount, "sats")}</dd>
                  <dt>Price holds for</dt>
                  <dd>{expiresIn > 0 ? formatCountdown(expiresIn) : "expired"}</dd>
                </dl>
                {requoted && <p className="hint" role="status">This is a new price. Check it before you send.</p>}
                <p className="note">Nimiq Pay shows what this costs in NIM or USDT, including its swap fee, before you approve. Errand never holds your money.</p>
              </>
            )}
            {error && <p className="alert" role="alert">{error}</p>}
            <div className="grow" />
            {quote && expiresIn > 0 ? (
              <button className="primary" disabled={busy || now < armedAt} onClick={() => void send()}>
                {busy ? (PRACTICE ? "Practising…" : "Opening Nimiq Pay…") : `${PRACTICE ? "Practise sending" : "Send"} ${formatMoney(quote.receive.amount, quote.receive.currency)}`}
              </button>
            ) : (
              quote && !busy && <button className="secondary" onClick={() => void getQuote()}>Get a new price</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
