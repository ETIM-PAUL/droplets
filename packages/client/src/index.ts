import { UserFacingError, type AirtimeOperator, type Corridor, type CountryCode } from "@railkit/core";
import type { Draft, Missing, QrUnderstood, Understood } from "@railkit/agent";
import type { RampOffer, RampOfferError, RampState } from "@railkit/adapters/server";
import type { AirtimeGateway, AirtimeQuote, AirtimeState, PayoutGateway, PayoutOrderStatus, PayoutQuote } from "@railkit/adapters";

export class ApiError extends UserFacingError {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface RailkitClientOptions {
  /** e.g. "/api" behind the Mini App's dev proxy, or the deployed API's URL. */
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Beta session token, read on every call. */
  token?: () => string | null;
  /** Called when the API says the session is missing or has ended. */
  onUnauthorized?: () => void;
}

/** Typed client for the RailKit API. Holds no secrets; the API holds the provider keys. */
export function createRailkitClient(o: RailkitClientOptions) {
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = o.baseUrl.replace(/\/$/, "");

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      const token = o.token?.();
      const headers = { ...(init?.headers as Record<string, string> | undefined), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
      res = await doFetch(base + path, { ...init, headers, signal: AbortSignal.timeout(o.timeoutMs ?? 20_000) });
    } catch {
      throw new ApiError("Can't reach Errand's server. Check your connection and try again.", 0);
    }
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (res.status === 401) o.onUnauthorized?.();
    if (!res.ok) throw new ApiError(body?.error?.message ?? "Errand's server had a problem. Try again in a minute.", res.status);
    return body as T;
  }

  const gateway: PayoutGateway = {
    quote: (req) => call<PayoutQuote>("/v1/payouts/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) }),
    getOrder: (orderId) => call<PayoutOrderStatus>(`/v1/payouts/orders/${encodeURIComponent(orderId)}`),
  };

  /** The route only knows the E.164 phone; the API needs the country for its kill switch. */
  const airtime = (country: CountryCode): AirtimeGateway => ({
    quote: (req) =>
      call<AirtimeQuote>("/v1/airtime/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...req, country }) }),
    status: (invoiceId) => call<{ invoiceId: string; state: AirtimeState }>(`/v1/airtime/invoices/${encodeURIComponent(invoiceId)}`),
  });

  const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  return {
    session: (invite: string) => call<{ token: string | null; name: string | null }>("/v1/session", json({ invite })),
    /** Practice mode only: asks the API to have Mavapay staging pretend the order was paid. */
    simulatePayment: (orderId: string) => call<{ simulated: true }>(`/v1/dev/simulate-payment/${encodeURIComponent(orderId)}`, json({})),
    feedback: (message: string, orderId?: string) => call<{ received: true }>("/v1/feedback", json({ message, orderId })),
    payouts: gateway,
    airtime,
    lookupAirtime: (country: CountryCode, phone: string) =>
      call<{ phone: string; operator: AirtimeOperator }>(`/v1/airtime/lookup?country=${country}&phone=${encodeURIComponent(phone)}`),
    /** One chat turn: Errand reads the sentence (or the answer to its last question) and says what's still missing. */
    understand: (text: string, draft?: Draft, expecting?: Missing) => call<Understood>("/v1/agent/understand", json({ text, draft, expecting })),
    /** A QR the phone couldn't read itself. */
    understandQr: (text: string, network: "mainnet" | "testnet") => call<QrUnderstood>("/v1/agent/qr", json({ text, network })),
    /** Add money: where it's switched on, offers for an amount, and orders the provider takes payment for. */
    topupOptions: async () => (await call<{ countries: { country: CountryCode; currency: string }[] }>("/v1/topup/options")).countries,
    topupOffers: (req: { country: string; amount: string; walletAddress: string }) =>
      call<{ currency: string; offers: RampOffer[]; errors: RampOfferError[] }>("/v1/topup/offers", json(req)),
    createTopup: (req: { country: string; amount: string; walletAddress: string; providerCode: string; paymentMethod?: string; userId: string }) =>
      call<{ orderId: string; redirectUrl: string }>("/v1/topup/orders", json(req)),
    topupStatus: (orderId: string) =>
      call<{ orderId: string; state: RampState; payoutAmount: string | null; transactionHash: string | null }>(`/v1/topup/orders/${encodeURIComponent(orderId)}`),
    corridors: async () => (await call<{ corridors: Corridor[] }>("/v1/corridors")).corridors,
    banks: async () => (await call<{ banks: { name: string; code: string }[] }>("/v1/payouts/banks?country=NG")).banks,
    nameEnquiry: (accountNumber: string, bankCode: string) =>
      call<{ accountName: string }>(`/v1/payouts/name-enquiry?accountNumber=${encodeURIComponent(accountNumber)}&bankCode=${encodeURIComponent(bankCode)}`),
  };
}

export type RailkitClient = ReturnType<typeof createRailkitClient>;
