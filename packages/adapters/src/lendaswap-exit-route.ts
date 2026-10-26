import {
  isDecimal,
  msatToSats,
  parseBolt11,
  toScaled,
  fromScaled,
  UserFacingError,
  type EvmChain,
  type PayIntent,
  type ProviderStatus,
  type Quote,
  type RouteAdapter,
} from "@railkit/core";

/**
 * The slice of the LendaSwap client (`@satora/swap`) this route needs. The real client lives in the Mini App,
 * because the swap secret and claim key are derived from a wallet kept on the user's device.
 */
export interface LendaswapLike {
  /** Lightning to stablecoin swap. The server returns a hold invoice locked to `hashLock`, a hash of a secret only this client knows. */
  createSwap(a: { chain: EvmChain; targetAddress: string; targetUnits: string }): Promise<{
    id: string;
    invoice: string;
    /** 0x-prefixed sha256 of our secret; the invoice must be locked to it. */
    hashLock: string;
    sourceSats: string;
    targetUnits: string;
    feeSats: string;
    /** Unix seconds, or null. */
    invoiceExpiresAt: number | null;
  }>;
  getSwap(id: string): Promise<{ status: string }>;
  /** Gasless claim of the USDC at the target address; reveals the secret so the server can settle the held payment. */
  claim(id: string): Promise<unknown>;
}

export interface LendaswapExitOptions {
  client: LendaswapLike;
  network: "mainnet" | "testnet";
  now?: () => number;
  etaSeconds?: number;
  expiryMarginMs?: number;
  /** Largest quote lifetime regardless of the invoice's own expiry. */
  quoteTtlMs?: number;
}

export class ExitRouteError extends UserFacingError {}

const USDC_DECIMALS = 6;
const PREFIX = "lendaswap:";

const FAILED_STATUSES = new Set([
  "expired",
  "clientrefunded",
  "clientfundedserverrefunded",
  "clientrefundedserverfunded",
  "clientrefundedserverrefunded",
  "serverwontfund",
  "clientfundedtoolate",
  "clientinvalidfunded",
  "clientredeemedandclientrefunded",
]);

/**
 * NIM to USDC: pay a LendaSwap Lightning hold invoice from the wallet, then claim the stablecoins
 * at the chosen address. Claiming has to run where the client's keys are, so `poll` belongs in the Mini App.
 */
export function lendaswapExitRoute(o: LendaswapExitOptions): RouteAdapter {
  const now = o.now ?? Date.now;
  const claiming = new Set<string>();

  return {
    id: "lendaswap-exit",

    canHandle: (i: PayIntent) => i.destination.kind === "evm-address" && i.amount?.currency === "USDC" && !!i.targetChain,

    async quote(i): Promise<Omit<Quote, "id" | "routeId" | "intent">> {
      const d = i.destination;
      if (d.kind !== "evm-address" || !i.amount || !i.targetChain) throw new ExitRouteError("Choose an amount and a network to send to.");
      if (!isDecimal(i.amount.amount) || toScaled(i.amount.amount) === 0n) throw new ExitRouteError("Enter an amount greater than zero.");

      const scaled = toScaled(i.amount.amount);
      const unitFactor = 10n ** BigInt(18 - USDC_DECIMALS);
      if (scaled % unitFactor !== 0n) throw new ExitRouteError(`USDC supports at most ${USDC_DECIMALS} decimal places.`);
      const targetUnits = (scaled / unitFactor).toString();

      let swap;
      try {
        swap = await o.client.createSwap({ chain: i.targetChain, targetAddress: d.address, targetUnits });
      } catch (e) {
        if (e instanceof UserFacingError) throw e;
        throw new ExitRouteError("The conversion service couldn't price this right now. Try a different amount or try again in a minute.");
      }

      // The hold invoice has to be locked to OUR secret's hash, or the server could keep the payment and never deliver.
      const inv = parseBolt11(swap.invoice);
      const refuse = new ExitRouteError("The conversion service sent an invoice that doesn't match the quote, so nothing was paid.");
      if (!inv.ok) throw refuse;
      const invoice = inv.value;
      if (invoice.paymentHash !== swap.hashLock.replace(/^0x/, "").toLowerCase()) throw refuse;
      if (invoice.amountMsat !== (BigInt(swap.sourceSats) * 1000n).toString()) throw refuse;
      if (invoice.network !== o.network) throw refuse;
      if (swap.targetUnits !== targetUnits) throw refuse;

      const nowMs = now();
      const expiresAt = Math.min(
        nowMs + (o.quoteTtlMs ?? 120_000),
        (swap.invoiceExpiresAt ?? invoice.expiresAt) * 1000 - (o.expiryMarginMs ?? 30_000),
      );
      if (expiresAt <= nowMs) throw new ExitRouteError("This quote is about to expire. Try again.");

      const receive = { amount: fromScaled(scaled), currency: "USDC" };
      const send = { amount: swap.sourceSats, currency: "SAT" };
      return {
        send,
        receive,
        fee: { amount: swap.feeSats, currency: "SAT" },
        etaSeconds: o.etaSeconds ?? 120,
        expiresAt,
        steps: [{ kind: "pay-lightning-invoice", invoice: swap.invoice }],
        providerRef: PREFIX + swap.id,
        notes: [
          `You pay about ${msatToSats((BigInt(swap.sourceSats) * 1000n).toString())} sats' worth of NIM or USDT; Nimiq Pay shows the exact amount and its swap fee before you approve.`,
          "Keep Errand open until it says the USDC has arrived. It completes the conversion from your phone.",
        ],
      };
    },

    async open(quote) {
      return { providerRef: quote.providerRef ?? "" };
    },

    async poll(providerRef): Promise<ProviderStatus> {
      const id = providerRef.slice(PREFIX.length);
      let status: string;
      try {
        status = (await o.client.getSwap(id)).status;
      } catch {
        return { status: "processing" }; // transient; the stuck-order check catches a service that never answers
      }

      if (status === "pending" || status === "clientfundingseen") return { status: "pending" };

      if (status === "serverfunded") {
        if (!claiming.has(id)) {
          claiming.add(id);
          try {
            await o.client.claim(id);
          } catch {
            // Try again on the next poll; the swap stays claimable until its timelock.
          } finally {
            claiming.delete(id);
          }
        }
        return { status: "processing" };
      }

      if (status === "clientredeemed" || status === "serverredeemed") return { status: "completed", verified: true };

      if (FAILED_STATUSES.has(status)) {
        return {
          status: "failed",
          message: "the conversion didn't complete. Any payment that wasn't used is returned automatically; if you don't see it within an hour, contact support",
        };
      }
      return { status: "processing" }; // clientfunded, clientredeeming, and statuses we haven't seen
    },
  };
}
