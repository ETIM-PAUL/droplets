import { maskRecipient } from "../corridors";
import { groupDigits, type Money } from "../money";
import type { Order } from "./types";

export interface Receipt {
  orderId: string;
  /** Who was paid, as the user knows them (address, merchant, ...). */
  recipient: string;
  receive: Money;
  fee: Money;
  send: Money;
  completedAt: number;
  /** Wallet references: Lightning payments use "txHash:swapId". */
  refs: string[];
  settlement: "verified" | "unverified";
}

function recipientOf(order: Order): string {
  const d = order.quote.intent.destination;
  switch (d.kind) {
    case "lightning-address":
      return `${d.user}@${d.domain}`;
    case "lnurl":
      return new URL(d.url).hostname;
    case "emvco":
      return d.merchantName ?? "Merchant";
    case "airtime":
      return `${d.operatorName ?? d.operatorId} top-up for ${d.phone.slice(0, 4)}••••${d.phone.slice(-3)}`;
    case "fiat-payout":
      return maskRecipient(d.recipient);
    case "evm-address":
      return d.address;
    case "bolt11":
      return d.description ?? "Lightning invoice";
  }
}

/** Only completed orders have a receipt. */
export function buildReceipt(order: Order): Receipt | null {
  if (order.state !== "completed") return null;
  return {
    orderId: order.id,
    recipient: recipientOf(order),
    receive: order.quote.receive,
    fee: order.quote.fee,
    send: order.quote.send,
    completedAt: order.updatedAt,
    refs: order.stepRefs,
    settlement: order.settlement ?? "unverified",
  };
}

/** Plain text the sender can share with the recipient. Contains no secrets. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "27 Oct 2026, 20:40 UTC": the same for sender and recipient, whatever their time zones. */
export function receiptDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** Plain text the sender can share with the recipient. Contains no secrets. */
export function receiptText(r: Receipt): string {
  return [
    "Payment receipt",
    `To: ${r.recipient}`,
    `Amount: ${groupDigits(r.receive.amount)} ${r.receive.currency}`,
    `Date: ${receiptDate(r.completedAt)}`,
    `Reference: ${r.orderId}`,
    r.settlement === "verified"
      ? "Status: delivered, confirmed by the provider"
      : "Status: sent. The recipient's service doesn't confirm receipt, so ask them to check.",
  ].join("\n");
}
