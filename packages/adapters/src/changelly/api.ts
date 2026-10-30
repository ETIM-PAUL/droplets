import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { ProviderError } from "../provider-error";

export interface ChangellyFiatOptions {
  /** X-Api-Key from Changelly. */
  publicKey: string;
  /** The RSA private key Changelly issues, as given: base64 of a PKCS#1 PEM. */
  privateKey: string;
  /** Changelly's key for webhook signatures, same encoding. */
  callbackPublicKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type RampFlow = "buy" | "sell";

export interface RampOffer {
  providerCode: string;
  /** What the user gets, in the target currency, before network fees the provider may still take. */
  amountExpectedTo: string;
  fee: string;
  rate: string;
  methods: { method: string; methodName: string; amountExpectedTo: string; fee: string }[];
}

export interface RampOfferError {
  providerCode: string;
  /** Changelly's error type (limits, country, currency, ...) and a message safe to show. */
  errorType: string;
  message: string;
}

export interface RampOrder {
  orderId: string;
  externalOrderId: string;
  redirectUrl: string;
}

/** Our view of a Changelly order, whatever words its providers use. */
export type RampState = "awaiting_payment" | "processing" | "completed" | "failed" | "hold";

export interface RampOrderStatus {
  orderId: string;
  externalOrderId: string;
  state: RampState;
  /** The provider's own status word, for logs and support. */
  status: string;
  payoutAmount: string | null;
  transactionHash: string | null;
}

/**
 * Changelly's docs don't publish the status list, so unknown words count as still processing.
 * That is the safe side: the order stays watched, and the stuck-order alert fires if it never ends.
 */
export function rampState(status: string): RampState {
  const s = status.toLowerCase();
  if (["completed", "complete", "finished", "success", "succeeded", "done"].includes(s)) return "completed";
  if (["failed", "expired", "refunded", "cancelled", "canceled", "declined", "rejected", "overdue"].includes(s)) return "failed";
  if (s === "hold") return "hold";
  if (["created", "new", "waiting", "pending_payment", "awaiting_payment"].includes(s)) return "awaiting_payment";
  return "processing";
}

const MESSAGES: Record<string, string> = {
  limits: "That amount is outside what this provider accepts. Try a different amount.",
  country: "This provider doesn't serve your country.",
  state: "This provider doesn't serve your region.",
  currency: "This provider can't do that currency right now.",
  paymentMethod: "That payment method isn't available for this amount or country.",
  invalidOffer: "That offer has changed. Get new offers and try again.",
  unavailable: "This provider is unavailable right now. Try again in a few minutes.",
  timeout: "This provider didn't answer in time. Try again.",
};

const pemKey = (b64: string, kind: "private" | "public") => {
  const o = { key: b64, format: "pem" as const, type: "pkcs1" as const, encoding: "base64" as const };
  return kind === "private" ? createPrivateKey(o) : createPublicKey(o);
};

/**
 * Changelly Fiat API: an aggregator of on- and off-ramp providers (card, bank transfer). The user pays on
 * the provider's own page and the crypto goes straight to their address. Errand never holds the money,
 * and the provider runs its own identity checks. Server-side only: requests are signed with our key.
 */
export function createChangellyFiatApi(o: ChangellyFiatOptions) {
  const base = (o.baseUrl ?? "https://fiat-api.changelly.com").replace(/\/$/, "");
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const key = pemKey(o.privateKey, "private");

  /** Signature over the full URL (with query) followed by the JSON body, or "{}" for none. As in Changelly's SDK. */
  function signature(url: string, body: unknown): string {
    return sign("sha256", Buffer.from(url + JSON.stringify(body ?? {})), key).toString("base64");
  }

  async function call<T>(method: "GET" | "POST", path: string, query?: Record<string, string>, body?: object): Promise<T> {
    const url = new URL(path, base + "/");
    if (query) url.search = new URLSearchParams(query).toString();
    let res: Response;
    try {
      res = await doFetch(url.toString(), {
        method,
        headers: { "Content-Type": "application/json", "X-Api-Key": o.publicKey, "X-Api-Signature": signature(url.toString(), body) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      });
    } catch {
      throw new ProviderError("Couldn't reach the top-up provider. Try again in a minute.", 502);
    }
    const j = (await res.json().catch(() => null)) as { errorType?: string; errorMessage?: string } | null;
    if (!res.ok) {
      const msg = (j?.errorType && MESSAGES[j.errorType]) || "The top-up provider had a problem. Try again in a minute.";
      throw new ProviderError(msg, res.status === 400 ? 400 : 502);
    }
    return j as T;
  }

  return {
    signature,

    /** Crypto tickers on sale (buy) or bought (sell), to find NIM's ticker and limits. */
    currencies: (flow: RampFlow) =>
      call<{ ticker: string; name: string; type: string; network?: string; providers?: { providerCode: string; limits?: unknown }[] }[]>(
        "GET", "/v1/currencies", { type: "crypto", supportedFlow: flow },
      ),

    async offers(q: { currencyFrom: string; currencyTo: string; amountFrom: string; country: string; ip?: string; externalUserId?: string }): Promise<{ offers: RampOffer[]; errors: RampOfferError[] }> {
      const query: Record<string, string> = { currencyFrom: q.currencyFrom, currencyTo: q.currencyTo, amountFrom: q.amountFrom, country: q.country };
      if (q.ip) query.ip = q.ip;
      if (q.externalUserId) query.externalUserId = q.externalUserId;
      const list = await call<Record<string, unknown>[]>("GET", "/v1/offers", query);
      const offers: RampOffer[] = [];
      const errors: RampOfferError[] = [];
      for (const x of Array.isArray(list) ? list : []) {
        const providerCode = String(x.providerCode ?? "");
        if (typeof x.errorType === "string") {
          errors.push({ providerCode, errorType: x.errorType, message: MESSAGES[x.errorType] ?? "This provider can't take this order." });
          continue;
        }
        if (typeof x.amountExpectedTo !== "string") continue;
        const methods = Array.isArray(x.paymentMethodOffers) ? (x.paymentMethodOffers as Record<string, unknown>[]) : [];
        offers.push({
          providerCode,
          amountExpectedTo: x.amountExpectedTo,
          fee: String(x.fee ?? "0"),
          rate: String(x.rate ?? ""),
          methods: methods
            .filter((m) => typeof m.method === "string" && typeof m.amountExpectedTo === "string")
            .map((m) => ({ method: String(m.method), methodName: String(m.methodName ?? m.method), amountExpectedTo: String(m.amountExpectedTo), fee: String(m.fee ?? "0") })),
        });
      }
      // Best first: most crypto for the money.
      offers.sort((a, b) => Number(b.amountExpectedTo) - Number(a.amountExpectedTo));
      return { offers, errors };
    },

    async validateAddress(currency: string, walletAddress: string): Promise<boolean> {
      const r = await call<{ result?: boolean }>("POST", "/v1/validate-address", undefined, { currency, walletAddress });
      return r.result === true;
    },

    async createOrder(q: {
      externalOrderId: string;
      externalUserId: string;
      providerCode: string;
      currencyFrom: string;
      currencyTo: string;
      amountFrom: string;
      country: string;
      walletAddress: string;
      paymentMethod?: string;
      ip?: string;
      userAgent?: string;
    }): Promise<RampOrder> {
      const r = await call<{ orderId?: unknown; redirectUrl?: unknown; externalOrderId?: unknown }>("POST", "/v1/orders", undefined, q);
      if (typeof r.orderId !== "string" || typeof r.redirectUrl !== "string" || !/^https:\/\//.test(r.redirectUrl)) {
        throw new ProviderError("The top-up provider sent back something Errand couldn't use. Nothing was charged.", 502);
      }
      return { orderId: r.orderId, externalOrderId: q.externalOrderId, redirectUrl: r.redirectUrl };
    },

    /** Looks an order up by our id. The response shape isn't documented, so both a list and {data: [...]} are read. */
    async getOrder(externalOrderId: string): Promise<RampOrderStatus | null> {
      const r = await call<unknown>("GET", "/v1/orders", { externalOrderId });
      const list = Array.isArray(r) ? r : Array.isArray((r as { data?: unknown })?.data) ? (r as { data: unknown[] }).data : [];
      const x = (list as Record<string, unknown>[]).find((i) => i.externalOrderId === externalOrderId);
      return x ? readOrder(x) : null;
    },

    /**
     * A webhook is genuine when its API key is ours and Changelly signed {"orderId": ...} with its key.
     * Returns the order as sent, or null for anything else.
     */
    readCallback(headers: { apiKey?: string; signature?: string }, raw: string): RampOrderStatus | null {
      if (!o.callbackPublicKey || headers.apiKey !== o.publicKey || !headers.signature) return null;
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return null;
      }
      if (typeof body.orderId !== "string") return null;
      const ok = verify("sha256", Buffer.from(JSON.stringify({ orderId: body.orderId })), pemKey(o.callbackPublicKey, "public"), Buffer.from(headers.signature, "base64"));
      return ok ? readOrder(body) : null;
    },
  };
}

function readOrder(x: Record<string, unknown>): RampOrderStatus | null {
  if (typeof x.orderId !== "string" || typeof x.status !== "string") return null;
  return {
    orderId: x.orderId,
    externalOrderId: typeof x.externalOrderId === "string" ? x.externalOrderId : "",
    state: rampState(x.status),
    status: x.status,
    payoutAmount: typeof x.payoutAmount === "string" || typeof x.payoutAmount === "number" ? String(x.payoutAmount) : null,
    transactionHash: typeof x.transactionHash === "string" ? x.transactionHash : null,
  };
}

export type ChangellyFiatApi = ReturnType<typeof createChangellyFiatApi>;
