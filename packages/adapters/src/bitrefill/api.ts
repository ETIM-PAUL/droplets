import { chooseAirtimeAmount, type AirtimeOperator, type Money } from "@railkit/core";
import { ProviderError } from "../provider-error";

export interface AirtimeQuote {
  invoiceId: string;
  /** BOLT11 invoice the wallet pays. */
  invoice: string;
  sats: string;
  receive: Money;
}

export type AirtimeState = "awaiting_payment" | "paid" | "delivered" | "failed";

export interface AirtimeGateway {
  quote(req: { phone: string; operatorId: string; amount: Money }): Promise<AirtimeQuote>;
  status(invoiceId: string): Promise<{ invoiceId: string; state: AirtimeState }>;
}

type Json = Record<string, unknown>;
interface BitrefillProduct {
  id?: string;
  name?: string;
  country_code?: string;
  currency?: string;
  in_stock?: boolean;
  recipient_type?: string;
  packages?: { id?: string; value?: string; price?: number }[];
  range?: { min?: number; max?: number; step?: number };
}
interface BitrefillInvoice {
  id?: string;
  status?: string;
  payment?: { method?: string; address?: string; price?: number; status?: string };
  orders?: { status?: string }[];
}

/** Maps a Bitrefill invoice (as the live API returns it, which differs from its docs) to our state. */
export function invoiceState(inv: BitrefillInvoice): AirtimeState {
  const orders = inv.orders ?? [];
  if (orders.length > 0 && orders.every((o) => o.status === "delivered")) return "delivered";
  if (inv.status === "all_error" || inv.status === "denied" || inv.status === "payment_error" || orders.some((o) => o.status === "permanent_failure")) {
    return "failed";
  }
  if (inv.payment?.status === "unpaid" || inv.payment?.status === undefined) return "awaiting_payment";
  return "paid";
}

function toOperator(p: BitrefillProduct): AirtimeOperator | null {
  if (typeof p.id !== "string" || typeof p.name !== "string" || typeof p.currency !== "string") return null;
  return {
    id: p.id,
    name: p.name,
    country: p.country_code ?? "",
    currency: p.currency,
    packages: (p.packages ?? [])
      .filter((x) => typeof x.id === "string" && typeof x.value === "string" && typeof x.price === "number")
      .map((x) => ({ id: x.id!, value: x.value!, priceSats: String(x.price) })),
    range:
      typeof p.range?.min === "number" && typeof p.range.max === "number"
        ? { min: String(p.range.min), max: String(p.range.max), step: String(p.range.step ?? 1) }
        : null,
  };
}

export interface BitrefillOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Our webhook URL, including its secret token. Bitrefill doesn't sign webhooks, so the token is the only check. */
  webhookUrl?: string;
  /** Invoice status cache. Bitrefill allows 60 GET /invoices/{id} per 10 minutes for the whole account. */
  statusTtlMs?: number;
  statusBudget?: { calls: number; perMs: number };
  /** Phone lookups: 10 per minute account-wide. */
  lookupBudget?: { calls: number; perMs: number };
}

function budget(calls: number, perMs: number, now: () => number) {
  const times: number[] = [];
  return () => {
    const t = now();
    while (times.length && times[0]! <= t - perMs) times.shift();
    if (times.length >= calls) return false;
    times.push(t);
    return true;
  };
}

/** Server-side Bitrefill client. The API key never leaves the server. */
export function createBitrefillApi(o: BitrefillOptions) {
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const statusTtl = o.statusTtlMs ?? 30_000;
  const statusAllowed = budget(o.statusBudget?.calls ?? 50, o.statusBudget?.perMs ?? 600_000, now);
  const lookupAllowed = budget(o.lookupBudget?.calls ?? 8, o.lookupBudget?.perMs ?? 60_000, now);
  const statusCache = new Map<string, { state: AirtimeState; at: number; stale: boolean }>();
  const lookupCache = new Map<string, { op: AirtimeOperator; at: number }>();
  const operators = new Map<string, AirtimeOperator>();

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Json> {
    let res: Response;
    try {
      res = await doFetch(o.baseUrl + path, {
        method,
        headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ProviderError("The top-up service isn't responding. Try again in a minute.", 502);
    }
    const j = (await res.json().catch(() => null)) as Json | null;
    if (res.ok && j) return j;
    if (res.status === 429) throw new ProviderError("The top-up service is busy. Try again in a minute.", 502);
    const code = typeof j?.error_code === "string" ? j.error_code : "";
    // Bitrefill answers an invalid number with HTTP 500 and error_code invalid_number.
    if (code === "invalid_number" || code === "invalid_phone_number") throw new ProviderError("That phone number isn't valid. Check it and try again.", 400);
    if (code === "unsupported_operator") throw new ProviderError("We can't top up this number's network yet.", 400);
    if (res.status >= 400 && res.status < 500 && typeof j?.message === "string") throw new ProviderError(j.message.slice(0, 300), 400);
    throw new ProviderError("The top-up service had a problem. Try again in a minute.", 502);
  }

  async function lookup(phone: string): Promise<AirtimeOperator> {
    const cached = lookupCache.get(phone);
    if (cached && now() - cached.at < 24 * 3600_000) return cached.op;
    if (!lookupAllowed()) throw new ProviderError("Lots of people are looking up numbers right now. Try again in a minute.", 502);
    const j = await call("GET", `/check_phone_number?phone_number=${encodeURIComponent(phone)}`);
    const p = j.data as BitrefillProduct | undefined;
    // Bitrefill answers with the last product bought for a number, which can be one of its free test
    // products (seen live). Those never top up a real phone, so treat them as no match.
    const real = p && p.recipient_type === "phone_number" && !String(p.id).startsWith("test-");
    const op = real ? toOperator(p) : null;
    if (!op) throw new ProviderError("We couldn't find a network for this number. Check it and try again.", 404);
    if (p!.in_stock === false) throw new ProviderError(`${op.name} top-ups are unavailable right now. Try again later.`, 400);
    lookupCache.set(phone, { op, at: now() });
    operators.set(op.id, op);
    return op;
  }

  const gateway: AirtimeGateway = {
    async quote({ phone, operatorId, amount }) {
      // Re-check the operator from our own lookup, so a client can't pair a number with someone else's product.
      const op = await lookup(phone);
      if (op.id !== operatorId) throw new ProviderError("This number's network changed. Look it up again.", 400);
      const choice = chooseAirtimeAmount(op, amount);
      if (!choice.ok) throw new ProviderError(choice.error.message, 400);

      const item = choice.value.packageId
        ? { product_id: op.id, package_id: choice.value.packageId, quantity: 1, phone_number: phone }
        : { product_id: op.id, value: choice.value.value, quantity: 1, phone_number: phone };
      const j = await call("POST", "/invoices", {
        products: [item],
        payment_method: "lightning",
        auto_pay: false,
        ...(o.webhookUrl ? { webhook_url: o.webhookUrl } : {}),
      });
      const inv = j.data as BitrefillInvoice | undefined;
      if (typeof inv?.id !== "string" || inv.payment?.method !== "lightning" || typeof inv.payment.address !== "string" || typeof inv.payment.price !== "number") {
        throw new ProviderError("The top-up service sent an incomplete invoice. Try again.", 502);
      }
      statusCache.set(inv.id, { state: "awaiting_payment", at: now(), stale: false });
      return { invoiceId: inv.id, invoice: inv.payment.address, sats: String(inv.payment.price), receive: { amount: choice.value.value, currency: op.currency } };
    },

    async status(invoiceId) {
      const c = statusCache.get(invoiceId);
      const final = c && (c.state === "delivered" || c.state === "failed");
      if (c && (final || (!c.stale && now() - c.at < statusTtl))) return { invoiceId, state: c.state };
      // Over budget: answer from cache rather than burn the shared account limit.
      if (!statusAllowed()) return { invoiceId, state: c?.state ?? "awaiting_payment" };
      const j = await call("GET", `/invoices/${encodeURIComponent(invoiceId)}`);
      const inv = j.data as BitrefillInvoice | undefined;
      if (inv?.id !== invoiceId) throw new ProviderError("The top-up service sent an unexpected invoice.", 502);
      const state = invoiceState(inv);
      statusCache.set(invoiceId, { state, at: now(), stale: false });
      return { invoiceId, state };
    },
  };

  return {
    ...gateway,
    lookup,
    /** A webhook says this invoice changed. Bitrefill doesn't sign webhooks, so we only re-check, never trust the payload. */
    markStale(invoiceId: string) {
      const c = statusCache.get(invoiceId);
      if (c) c.stale = true;
    },
  };
}

export type BitrefillApi = ReturnType<typeof createBitrefillApi>;
