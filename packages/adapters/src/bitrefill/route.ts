import {
  isExpired,
  normalizePhone,
  parseBolt11,
  UserFacingError,
  type PayIntent,
  type ProviderStatus,
  type Quote,
  type RouteAdapter,
} from "@railkit/core";
import type { AirtimeGateway } from "./api";

export interface AirtimeRouteOptions {
  gateway: AirtimeGateway;
  network: "mainnet" | "testnet";
  /** Countries switched on (kill switch), e.g. {"KE"}. */
  enabledCountries: ReadonlySet<string>;
  now?: () => number;
  etaSeconds?: number;
  expiryMarginMs?: number;
}

export class AirtimeRouteError extends UserFacingError {}

const PREFIX = "airtime:";
const COUNTRY_BY_CODE: [string, "KE" | "NG" | "GH" | "ZA"][] = [["+254", "KE"], ["+234", "NG"], ["+233", "GH"], ["+27", "ZA"]];

/** Airtime top-ups: the wallet pays the provider's Lightning invoice, the provider tops up the phone. */
export function airtimeRoute(o: AirtimeRouteOptions): RouteAdapter {
  const now = o.now ?? Date.now;

  return {
    id: "airtime",

    canHandle: (i: PayIntent) => i.destination.kind === "airtime",

    async quote(i): Promise<Omit<Quote, "id" | "routeId" | "intent">> {
      const d = i.destination;
      if (d.kind !== "airtime" || !i.amount) throw new AirtimeRouteError("Choose an amount to top up.");
      const country = COUNTRY_BY_CODE.find(([code]) => d.phone.startsWith(code))?.[1];
      if (!country || !o.enabledCountries.has(country)) throw new AirtimeRouteError("Top-ups for this country are paused right now.");
      const phone = normalizePhone(d.phone, country);
      if (!phone.ok) throw new AirtimeRouteError(phone.error.message);

      const q = await o.gateway.quote({ phone: phone.value, operatorId: d.operatorId, amount: i.amount });

      const inv = parseBolt11(q.invoice);
      const refuse = new AirtimeRouteError("The top-up service sent an invoice that doesn't match its quote, so nothing was paid.");
      if (!inv.ok) throw refuse;
      if (inv.value.amountMsat !== (BigInt(q.sats) * 1000n).toString()) throw refuse;
      if (inv.value.network !== o.network) throw refuse;
      if (q.receive.currency !== i.amount.currency) throw refuse;
      if (isExpired(inv.value, Math.floor(now() / 1000))) throw new AirtimeRouteError("The quote expired before we could show it. Try again.");
      const expiresAt = inv.value.expiresAt * 1000 - (o.expiryMarginMs ?? 30_000);
      if (expiresAt <= now()) throw new AirtimeRouteError("The quote is about to expire. Try again.");

      return {
        send: { amount: q.sats, currency: "SAT" },
        receive: q.receive,
        // Bitrefill's margin is inside the price; it doesn't report a separate fee.
        fee: { amount: "0", currency: "SAT" },
        etaSeconds: o.etaSeconds ?? 60,
        expiresAt,
        steps: [{ kind: "pay-lightning-invoice", invoice: q.invoice }],
        providerRef: PREFIX + q.invoiceId,
        notes: [
          "Nimiq Pay shows the cost in NIM or USDT, including its swap fee, before you approve.",
          "Check the number before you pay: top-ups can't be reversed, and a failed one paid over Lightning is refunded by Errand support, not automatically.",
        ],
      };
    },

    async open(quote) {
      return { providerRef: quote.providerRef ?? "" };
    },

    async poll(providerRef): Promise<ProviderStatus> {
      let state;
      try {
        state = (await o.gateway.status(providerRef.slice(PREFIX.length))).state;
      } catch {
        return { status: "processing" };
      }
      switch (state) {
        case "awaiting_payment":
          return { status: "pending" };
        case "paid":
          return { status: "processing" };
        case "delivered":
          return { status: "completed", verified: true };
        case "failed":
          return { status: "failed", message: "the network didn't accept the top-up. Errand support will refund you" };
      }
    },
  };
}
