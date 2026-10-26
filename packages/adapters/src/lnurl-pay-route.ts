import {
  parseBolt11,
  isExpired,
  type PayIntent,
  type ProviderStatus,
  type Quote,
  type RouteAdapter,
  UserFacingError,
} from "@railkit/core";

export interface LnurlPayOptions {
  network: "mainnet" | "testnet";
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  etaSeconds?: number;
  /** Keep the quote this far inside the invoice's own expiry. */
  expiryMarginMs?: number;
}

type Json = Record<string, unknown>;

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const sha256Hex = async (bytes: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

/** User-facing failure from this route; the engine shows `message` as written. */
export class RouteError extends UserFacingError {}

/** A plain https URL (or http for .onion), as used by LNURL callbacks. */
function safeUrl(s: string): URL | null {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || (u.protocol === "http:" && u.hostname.endsWith(".onion")) ? u : null;
  } catch {
    return null;
  }
}

const SERVICE_ERROR = "The recipient's payment service didn't respond properly. Try again in a minute, or ask them to check it.";

/**
 * Pays Lightning Addresses and LNURL-pay links: fetch the service's pay request (LUD-06/16),
 * ask it for an invoice for the exact amount, check that invoice, then let the wallet pay it.
 * Settlement is tracked through the service's `verify` URL (LUD-21) when it offers one.
 */
export function lnurlPayRoute(o: LnurlPayOptions): RouteAdapter {
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const timeout = o.timeoutMs ?? 10_000;

  async function getJson(url: string): Promise<Json> {
    let res: Response;
    try {
      res = await doFetch(url, { signal: AbortSignal.timeout(timeout), headers: { Accept: "application/json" } });
    } catch {
      throw new RouteError(SERVICE_ERROR);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new RouteError(SERVICE_ERROR);
    }
    if (typeof body !== "object" || body === null) throw new RouteError(SERVICE_ERROR);
    const j = body as Json;
    if (typeof j.status === "string" && j.status.toUpperCase() === "ERROR") {
      throw new RouteError(`The recipient's service said no${typeof j.reason === "string" ? `: ${j.reason}` : ""}.`);
    }
    if (!res.ok) throw new RouteError(SERVICE_ERROR);
    return j;
  }

  const serviceUrl = (i: PayIntent): string | null => {
    const d = i.destination;
    if (d.kind === "lightning-address") return d.url;
    if (d.kind === "lnurl") return d.url;
    return null;
  };

  return {
    id: "lnurl-pay",

    canHandle: (i) => serviceUrl(i) !== null && i.amount?.currency === "SAT",

    async quote(i): Promise<Omit<Quote, "id" | "routeId" | "intent">> {
      const url = serviceUrl(i);
      if (!url || !i.amount) throw new RouteError("Enter how much to send.");
      if (!/^\d+$/.test(i.amount.amount) || i.amount.amount === "0") {
        throw new RouteError("Lightning amounts must be whole sats, more than zero.");
      }
      const amountMsat = BigInt(i.amount.amount) * 1000n;

      const p = await getJson(url);
      if (p.tag === "withdrawRequest") throw new RouteError("This is a withdrawal link, not a payment request. Errand can only pay.");
      if (p.tag !== "payRequest") throw new RouteError("This link isn't a payment request Errand understands.");

      const { callback, minSendable, maxSendable, metadata } = p;
      if (typeof callback !== "string" || typeof metadata !== "string" || typeof minSendable !== "number" || typeof maxSendable !== "number") {
        throw new RouteError(SERVICE_ERROR);
      }
      if (amountMsat < BigInt(minSendable) || amountMsat > BigInt(maxSendable)) {
        throw new RouteError(
          `This recipient accepts between ${Math.ceil(minSendable / 1000)} and ${Math.floor(maxSendable / 1000)} sats. Change the amount and try again.`,
        );
      }
      const callbackUrl = safeUrl(callback);
      if (!callbackUrl) throw new RouteError(SERVICE_ERROR);
      callbackUrl.searchParams.set("amount", amountMsat.toString());
      const r = await getJson(callbackUrl.toString());
      if (typeof r.pr !== "string") throw new RouteError(SERVICE_ERROR);

      const inv = parseBolt11(r.pr);
      if (!inv.ok) throw new RouteError("The recipient's service sent an invoice Errand couldn't read, so nothing was paid.");
      const invoice = inv.value;

      const mismatch = "The recipient's service sent an invoice that doesn't match its payment request, so Errand didn't pay it.";
      if (invoice.amountMsat !== amountMsat.toString()) throw new RouteError(mismatch);
      if (invoice.network !== o.network) throw new RouteError(mismatch);
      // LUD-06: the invoice must commit to the exact metadata the user was shown.
      if (invoice.descriptionHash !== (await sha256Hex(new TextEncoder().encode(metadata)))) throw new RouteError(mismatch);
      if (isExpired(invoice, Math.floor(now() / 1000))) throw new RouteError("The invoice has already expired. Try again.");

      const verify = typeof r.verify === "string" && safeUrl(r.verify) ? r.verify : "";
      const expiresAt = Math.min(now() + 120_000, invoice.expiresAt * 1000 - (o.expiryMarginMs ?? 30_000));
      if (expiresAt <= now()) throw new RouteError("The invoice is about to expire. Try again.");

      const receive = { amount: i.amount.amount, currency: "SAT" };
      return {
        send: receive,
        receive,
        // The swap fee depends on the user's choice of NIM or USDT and is only known in Nimiq Pay's dialog.
        fee: { amount: "0", currency: "SAT" },
        etaSeconds: o.etaSeconds ?? 60,
        expiresAt,
        steps: [{ kind: "pay-lightning-invoice", invoice: r.pr }],
        providerRef: `lnurl:${invoice.paymentHash}:${verify}`,
        notes: [
          "Nimiq Pay shows the final cost in NIM or USDT, including the swap fee, before you approve.",
          ...(verify ? [] : ["This recipient's service can't confirm receipt, so the receipt will say \"sent\" rather than \"confirmed\"."]),
        ],
      };
    },

    async open(quote) {
      return { providerRef: quote.providerRef ?? "" };
    },

    async poll(providerRef): Promise<ProviderStatus> {
      const [, paymentHash = "", ...rest] = providerRef.split(":");
      const verifyUrl = rest.join(":");
      if (!verifyUrl) return { status: "completed", verified: false };

      let j: Json;
      try {
        j = await getJson(verifyUrl);
      } catch {
        return { status: "processing" }; // transient; the stuck-order check catches a service that never answers
      }
      if (j.settled !== true) return { status: "processing" };
      if (typeof j.preimage === "string" && /^[0-9a-f]{64}$/i.test(j.preimage)) {
        if ((await sha256Hex(fromHex(j.preimage))) !== paymentHash) {
          return { status: "failed", message: "the recipient's confirmation didn't match the invoice" };
        }
      }
      return { status: "completed", verified: true };
    },
  };
}
