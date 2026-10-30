import { buildReceipt, destinationLabel, receiptText, stuckReason, type Order } from "@railkit/core";
import { useEffect, useState } from "react";
import { formatMoney } from "../format";
import { ReportProblem } from "../ReportProblem";
import { orderStore, sendEngine } from "./engine";

interface Props {
  orderId: string;
  enabled: ReadonlySet<string>;
  onHome: () => void;
  onRetry: (order: Order) => void;
}

const ACTIVE = new Set(["awaiting_approval", "submitting", "processing", "outcome_unknown"]);

/** Follows one order to the end and shows its receipt. Safe to reopen: tracking resumes from the stored order. */
export function OrderView({ orderId, enabled, onHome, onRetry }: Props) {
  const [order, setOrder] = useState<Order | null>(null);
  const [shared, setShared] = useState("");

  useEffect(() => {
    let stop = false;
    const engine = sendEngine(enabled);
    async function tick() {
      let o = await orderStore.get(orderId);
      if (o && (o.state === "processing" || o.state === "outcome_unknown")) o = await engine.poll(orderId).catch(() => o);
      if (stop) return;
      if (o) setOrder(o);
      if (!o || ACTIVE.has(o.state)) setTimeout(tick, o?.state === "processing" ? 6_000 : 1_500);
    }
    void tick();
    return () => { stop = true; };
  }, [orderId, enabled]);

  if (!order) return <div className="screen"><p className="hint">Loading your payment…</p></div>;

  const d = order.quote.intent.destination;
  const who = destinationLabel(d);
  const gets = formatMoney(order.quote.receive.amount, order.quote.receive.currency);
  const receipt = buildReceipt(order);
  const reached = (s: Order["state"]) => order.timeline.some((t) => t.to === s);
  const stuck = stuckReason(order, Date.now());

  const steps = [
    { label: "Approve in Nimiq Pay", done: reached("submitting"), now: order.state === "awaiting_approval" || order.state === "submitting" },
    { label: "Payment on its way", done: reached("processing"), now: order.state === "processing" },
    { label: `${who} gets ${gets}`, done: order.state === "completed", now: false },
  ];

  async function share() {
    if (!receipt) return;
    const text = receiptText(receipt);
    try {
      if (navigator.share) await navigator.share({ text });
      else {
        await navigator.clipboard.writeText(text);
        setShared("Receipt copied. Paste it into a message to send it.");
      }
    } catch {
      // The person closed the share sheet; nothing to do.
    }
  }

  return (
    <div className="screen">
      <div className="topbar">
        <button type="button" onClick={onHome}>Home</button>
        <span>{new Date(order.createdAt).toLocaleString()}</span>
      </div>

      {order.state === "completed" ? (
        <div>
          <p className="arrived-amount">{gets}</p>
          <p className="question">arrived with {who}.</p>
        </div>
      ) : (
        <h1 className="sentence">Sending {gets} to {who}</h1>
      )}

      <div className="grow">
        {!["cancelled", "failed", "expired"].includes(order.state) && (
          <ol className="timeline">
            {steps.map((s) => (
              <li key={s.label} className={s.done ? (order.state === "completed" && s === steps[2] ? "done arrived" : "done") : s.now ? "now" : ""}>{s.label}</li>
            ))}
          </ol>
        )}

        {order.message && order.state !== "completed" && <p className="alert" role="alert">{order.message}</p>}
        {stuck && order.state === "processing" && (
          <p className="note">This is taking longer than usual. You can close Errand; the payment keeps going and this screen catches up when you come back.</p>
        )}

        {receipt && (
          <>
            <pre className="receipt">{receiptText(receipt)}</pre>
            {shared && <p className="hint" role="status">{shared}</p>}
          </>
        )}

        <div className="grow" />
        {receipt && <button className="primary" onClick={() => void share()}>Share receipt with {who}</button>}
        {["cancelled", "failed", "expired"].includes(order.state) && (
          <button className="primary" onClick={() => onRetry(order)}>Try again</button>
        )}
        {!ACTIVE.has(order.state) && <button className="secondary" onClick={onHome}>Back to home</button>}
        <ReportProblem orderId={order.quote.providerRef?.split(":").slice(1).join(":") || order.id} />
      </div>
    </div>
  );
}
