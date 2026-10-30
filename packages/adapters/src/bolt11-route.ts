import { isExpired, msatToSats, type ProviderStatus, type Quote, type RouteAdapter } from "@railkit/core";
import { RouteError } from "./lnurl-pay-route";

export interface Bolt11RouteOptions {
  network: "mainnet" | "testnet";
  now?: () => number;
  etaSeconds?: number;
  /** Keep the quote this far inside the invoice's own expiry. */
  expiryMarginMs?: number;
}

/**
 * Pays a scanned or pasted Lightning invoice as it stands. There is no provider to ask afterwards,
 * so the receipt rests on Nimiq Pay's own success and says "sent", not "confirmed".
 */
export function bolt11Route(o: Bolt11RouteOptions): RouteAdapter {
  const now = o.now ?? Date.now;
  return {
    id: "lightning-invoice",

    canHandle: (i) => i.destination.kind === "bolt11",

    async quote(i): Promise<Omit<Quote, "id" | "routeId" | "intent">> {
      const inv = i.destination;
      if (inv.kind !== "bolt11") throw new RouteError("This isn't a Lightning invoice.");
      const wanted = o.network === "mainnet" ? "mainnet" : "testnet";
      if (inv.network !== wanted) {
        throw new RouteError(`This invoice is for bitcoin ${inv.network}, but Nimiq Pay is on ${o.network}. Ask for a ${wanted} invoice.`);
      }
      if (!inv.amountMsat) throw new RouteError("This invoice has no amount in it. Ask the recipient for an invoice with an amount.");
      if (isExpired(inv, Math.floor(now() / 1000))) throw new RouteError("This invoice has expired. Ask the recipient for a new one.");
      const expiresAt = Math.min(now() + 10 * 60_000, inv.expiresAt * 1000 - (o.expiryMarginMs ?? 30_000));
      if (expiresAt <= now()) throw new RouteError("This invoice is about to expire. Ask the recipient for a new one.");

      const sats = { amount: msatToSats(inv.amountMsat), currency: "SAT" };
      return {
        send: sats,
        receive: sats,
        // The swap fee depends on the user's choice of NIM or USDT and is only known in Nimiq Pay's dialog.
        fee: { amount: "0", currency: "SAT" },
        etaSeconds: o.etaSeconds ?? 60,
        expiresAt,
        steps: [{ kind: "pay-lightning-invoice", invoice: inv.raw }],
        providerRef: `bolt11:${inv.paymentHash}`,
        notes: [
          "Nimiq Pay shows the final cost in NIM or USDT, including the swap fee, before you approve.",
          "A plain invoice can't confirm receipt, so the receipt will say \"sent\" rather than \"confirmed\".",
        ],
      };
    },

    async open(quote) {
      return { providerRef: quote.providerRef ?? "" };
    },

    async poll(_ref, ctx): Promise<ProviderStatus> {
      return ctx?.walletSucceeded === false ? { status: "pending" } : { status: "completed", verified: false };
    },
  };
}
