import {
  CORRIDORS,
  isExpired,
  parseBolt11,
  UserFacingError,
  validatePayoutAmount,
  validateRecipient,
  type PayIntent,
  type ProviderStatus,
  type Quote,
  type RouteAdapter,
} from "@railkit/core";
import type { PayoutGateway } from "./api";

export interface PayoutRouteOptions {
  /** Our API in the Mini App; the Mavapay client directly on the server. */
  gateway: PayoutGateway;
  network: "mainnet" | "testnet";
  /** Corridors switched on; anything else is refused before any request. */
  enabled: ReadonlySet<string>;
  now?: () => number;
  etaSeconds?: number;
  expiryMarginMs?: number;
}

export class PayoutRouteError extends UserFacingError {}

const PREFIX = "payout:";

/** Mobile money and bank payouts: the wallet pays the provider's Lightning invoice, the provider pays the recipient. */
export function payoutRoute(o: PayoutRouteOptions): RouteAdapter {
  const now = o.now ?? Date.now;

  return {
    id: "fiat-payout",

    canHandle: (i: PayIntent) => i.destination.kind === "fiat-payout",

    async quote(i): Promise<Omit<Quote, "id" | "routeId" | "intent">> {
      const d = i.destination;
      if (d.kind !== "fiat-payout" || !i.amount) throw new PayoutRouteError("Enter how much the recipient should get.");
      if (!o.enabled.has(d.corridor)) {
        throw new PayoutRouteError(`${CORRIDORS[d.corridor]?.label ?? "This corridor"} is paused right now. Try again later.`);
      }
      const recipient = validateRecipient(d.corridor, d.recipient);
      if (!recipient.ok) throw new PayoutRouteError(recipient.error.message);
      const amount = validatePayoutAmount(d.corridor, i.amount);
      if (!amount.ok) throw new PayoutRouteError(amount.error.message);

      const q = await o.gateway.quote({ corridor: d.corridor, amount: amount.value, recipient: recipient.value });

      const inv = parseBolt11(q.invoice);
      const refuse = new PayoutRouteError("The payout service sent an invoice that doesn't match its quote, so nothing was paid.");
      if (!inv.ok) throw refuse;
      if (inv.value.amountMsat !== (BigInt(q.sats) * 1000n).toString()) throw refuse;
      if (inv.value.network !== o.network) throw refuse;
      if (q.receive.amount !== amount.value.amount || q.receive.currency !== amount.value.currency) throw refuse;
      if (isExpired(inv.value, Math.floor(now() / 1000))) throw new PayoutRouteError("The quote expired before we could show it. Try again.");

      const expiresAt = Math.min(q.expiresAt, inv.value.expiresAt * 1000) - (o.expiryMarginMs ?? 30_000);
      if (expiresAt <= now()) throw new PayoutRouteError("The quote is about to expire. Try again.");

      return {
        send: { amount: q.sats, currency: "SAT" },
        receive: q.receive,
        fee: { amount: q.feeSats, currency: "SAT" },
        etaSeconds: o.etaSeconds ?? 120,
        expiresAt,
        steps: [{ kind: "pay-lightning-invoice", invoice: q.invoice }],
        providerRef: PREFIX + q.orderId,
        notes: ["Nimiq Pay shows the cost in NIM or USDT, including its swap fee, before you approve."],
      };
    },

    async open(quote) {
      return { providerRef: quote.providerRef ?? "" };
    },

    async poll(providerRef): Promise<ProviderStatus> {
      let state;
      try {
        state = (await o.gateway.getOrder(providerRef.slice(PREFIX.length))).state;
      } catch {
        return { status: "processing" }; // transient; the stuck-order check catches an outage that lasts
      }
      switch (state) {
        case "awaiting_payment":
          return { status: "pending" };
        case "paid":
          return { status: "processing" };
        case "paid_out":
          return { status: "completed", verified: true };
        case "expired":
          return { status: "failed", message: "your payment didn't reach the payout service before the quote expired, so no payout was made" };
        case "failed":
          return { status: "failed", message: "the payout service couldn't pay the recipient. We'll follow up on the refund" };
      }
    },
  };
}
