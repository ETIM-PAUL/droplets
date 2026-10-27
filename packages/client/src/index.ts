import { UserFacingError, type AirtimeOperator, type Corridor, type CountryCode } from "@railkit/core";
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
}

/** Typed client for the RailKit API. Holds no secrets; the API holds the provider keys. */
export function createRailkitClient(o: RailkitClientOptions) {
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = o.baseUrl.replace(/\/$/, "");

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(base + path, { ...init, signal: AbortSignal.timeout(o.timeoutMs ?? 20_000) });
    } catch {
      throw new ApiError("Can't reach Errand's server. Check your connection and try again.", 0);
    }
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
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

  return {
    payouts: gateway,
    airtime,
    lookupAirtime: (country: CountryCode, phone: string) =>
      call<{ phone: string; operator: AirtimeOperator }>(`/v1/airtime/lookup?country=${country}&phone=${encodeURIComponent(phone)}`),
    corridors: async () => (await call<{ corridors: Corridor[] }>("/v1/corridors")).corridors,
    banks: async () => (await call<{ banks: { name: string; code: string }[] }>("/v1/payouts/banks?country=NG")).banks,
    nameEnquiry: (accountNumber: string, bankCode: string) =>
      call<{ accountName: string }>(`/v1/payouts/name-enquiry?accountNumber=${encodeURIComponent(accountNumber)}&bankCode=${encodeURIComponent(bankCode)}`),
  };
}

export type RailkitClient = ReturnType<typeof createRailkitClient>;
