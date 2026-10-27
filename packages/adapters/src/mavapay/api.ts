import { ProviderError } from "../provider-error";
import {
  CORRIDORS,
  fromScaled,
  toScaled,
  type CorridorId,
  type Money,
  type PayoutRecipient,
} from "@railkit/core";

/** What our API returns for a payout quote, whoever the provider is. */
export interface PayoutQuote {
  quoteId: string;
  orderId: string;
  /** BOLT11 invoice the wallet pays; the payout starts once it is paid. */
  invoice: string;
  /** Sats to pay, fee included. */
  sats: string;
  feeSats: string;
  receive: Money;
  /** Epoch ms. */
  expiresAt: number;
}

export type PayoutOrderState = "awaiting_payment" | "paid" | "paid_out" | "failed" | "expired";

export interface PayoutOrderStatus {
  orderId: string;
  state: PayoutOrderState;
}

export interface PayoutGateway {
  quote(req: { corridor: CorridorId; amount: Money; recipient: PayoutRecipient }): Promise<PayoutQuote>;
  getOrder(orderId: string): Promise<PayoutOrderStatus>;
}


const MINOR_UNIT: Record<string, { code: string; factor: bigint }> = {
  KES: { code: "KESCENT", factor: 100n },
  NGN: { code: "NGNKOBO", factor: 100n },
  GHS: { code: "GHSPESEWA", factor: 100n },
  ZAR: { code: "ZARCENT", factor: 100n },
};

const toMinor = (m: Money): string => {
  const unit = MINOR_UNIT[m.currency];
  if (!unit) throw new ProviderError(`Payouts in ${m.currency} aren't supported.`, 400);
  return ((toScaled(m.amount) * unit.factor) / 10n ** 18n).toString();
};

/** Mavapay's beneficiary object for each corridor (docs.mavapay.co/guides/beneficiary-formats). */
export function beneficiaryFor(corridor: CorridorId, r: PayoutRecipient): Record<string, unknown> {
  switch (corridor) {
    case "ke-mpesa":
    case "ke-airtel":
      if (r.type !== "mobile-money") break;
      return { identifierType: "paytophone", identifiers: { phoneNumber: r.phone, accountName: r.name, network: r.network } };
    case "gh-mtn":
      if (r.type !== "mobile-money") break;
      return { identifierType: "MTN", identifiers: { phoneNumber: r.phone, accountName: r.name } };
    case "ng-bank":
      if (r.type !== "bank") break;
      return { bankAccountName: r.accountName, bankCode: r.bankCode, bankName: r.bankName, bankAccountNumber: r.accountNumber };
    case "za-bank":
      if (r.type !== "bank") break;
      return { name: r.accountName, bankName: r.bankName, bankAccountNumber: r.accountNumber };
  }
  throw new ProviderError("These recipient details don't fit this corridor.", 400);
}

type Json = Record<string, unknown>;
interface OrderTx {
  type?: string;
  status?: string;
}

/** Maps a Mavapay order (GET /order) to our payout state. */
export function orderState(order: { status?: string; transactions?: OrderTx[] }): PayoutOrderState {
  const txs = order.transactions ?? [];
  const payout = txs.find((t) => t.type === "WITHDRAWAL");
  if (payout?.status === "SUCCESS") return "paid_out";
  if (payout?.status === "FAILED" || order.status === "FAILED") return "failed";
  if (order.status === "EXPIRED") return "expired";
  if (order.status === "PAID" || txs.some((t) => t.type === "DEPOSIT" && t.status === "SUCCESS")) return "paid";
  return "awaiting_payment";
}

export interface MavapayOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/** Server-side Mavapay client. The API key never leaves the server. */
export function createMavapayApi(o: MavapayOptions) {
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? Date.now;

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Json> {
    let res: Response;
    try {
      res = await doFetch(o.baseUrl + path, {
        method,
        headers: { "x-api-key": o.apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      });
    } catch {
      throw new ProviderError("The payout service isn't responding. Try again in a minute.", 502);
    }
    let j: Json;
    try {
      j = (await res.json()) as Json;
    } catch {
      throw new ProviderError("The payout service sent a reply we couldn't read. Try again in a minute.", 502);
    }
    if (res.ok && j.status === "ok") return j;
    // Mavapay's 4xx messages are specific and useful ("Amount cannot be less than 150 KES"), so pass them on.
    if (res.status >= 400 && res.status < 500 && typeof j.message === "string") {
      throw new ProviderError(j.message.slice(0, 300), j.message === "Order not found" ? 404 : 400);
    }
    throw new ProviderError("The payout service had a problem. Try again in a minute.", 502);
  }

  const gateway: PayoutGateway = {
    async quote({ corridor, amount, recipient }) {
      const minor = toMinor(amount);
      const target = MINOR_UNIT[amount.currency]!.code;
      const j = await call("POST", "/quote", {
        amount: minor,
        sourceCurrency: "BTCSAT",
        targetCurrency: target,
        paymentMethod: "LIGHTNING",
        paymentCurrency: target,
        autopayout: true,
        beneficiary: beneficiaryFor(corridor, recipient),
      });
      const d = j.data as Json | undefined;
      const invoice = d?.invoice;
      const sats = d?.totalAmountInSourceCurrency;
      const fee = d?.transactionFeesInSourceCurrency;
      const expiry = typeof d?.expiry === "string" ? Date.parse(d.expiry) : NaN;
      if (
        typeof d?.id !== "string" || typeof d.orderId !== "string" || typeof invoice !== "string" ||
        typeof sats !== "number" || typeof fee !== "number" || Number.isNaN(expiry) ||
        String(d.amountInTargetCurrency) !== minor
      ) {
        throw new ProviderError("The payout service sent an incomplete quote. Try again.", 502);
      }
      const unit = MINOR_UNIT[amount.currency]!;
      return {
        quoteId: d.id,
        orderId: d.orderId,
        invoice,
        sats: String(sats),
        feeSats: String(fee),
        receive: { amount: fromScaled((BigInt(minor) * 10n ** 18n) / unit.factor), currency: CORRIDORS[corridor].currency },
        // Mavapay's quote expiry and the invoice's own expiry can differ; the route takes the earlier.
        expiresAt: Math.min(expiry, now() + 30 * 60_000),
      };
    },

    async getOrder(orderId) {
      const j = await call("GET", `/order?id=${encodeURIComponent(orderId)}`);
      const d = j.data as { id?: string; status?: string; transactions?: OrderTx[] } | undefined;
      if (!d || d.id !== orderId) throw new ProviderError("The payout service sent an unexpected order.", 502);
      return { orderId, state: orderState(d) };
    },
  };

  return {
    ...gateway,
    async banks(country: "NG") {
      const j = await call("GET", `/bank/bankcode?country=${country}`);
      const list = (j.data as { bankName?: unknown; nipBankCode?: unknown }[] | undefined) ?? [];
      return list
        .filter((b) => typeof b.bankName === "string" && typeof b.nipBankCode === "string")
        .map((b) => ({ name: b.bankName as string, code: b.nipBankCode as string }));
    },
    async nameEnquiry(accountNumber: string, bankCode: string) {
      const j = await call("GET", `/bank/name-enquiry?accountNumber=${encodeURIComponent(accountNumber)}&bankCode=${encodeURIComponent(bankCode)}`);
      const d = j.data as { accountName?: unknown } | undefined;
      if (typeof d?.accountName !== "string") throw new ProviderError("We couldn't find that account. Check the number and bank.", 404);
      return { accountName: d.accountName };
    },
  };
}

export type MavapayApi = ReturnType<typeof createMavapayApi>;
