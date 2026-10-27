import { maskRecipient } from "../corridors";
import type { Money } from "../money";
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
export function receiptText(r: Receipt): string {
  const lines = [
    `Payment receipt`,
    `To: ${r.recipient}`,
    `Amount: ${r.receive.amount} ${r.receive.currency}`,
    `Date: ${new Date(r.completedAt).toISOString()}`,
    `Reference: ${r.orderId}`,
    r.settlement === "verified"
      ? "Status: confirmed by the recipient's service"
      : "Status: sent. The recipient's service doesn't offer confirmation, so ask them to check.",
  ];
  return lines.join("\n");
}
