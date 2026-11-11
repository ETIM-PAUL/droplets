import { UserFacingError, type AirtimeOperator, type CatchUpEvery, type Corridor, type CountryCode } from "@railkit/core";
import type { Draft, Missing, QrUnderstood, SavePeriod, SaveQuestion, Understood } from "@railkit/agent";
import type { RampOffer, RampOfferError, RampState } from "@railkit/adapters/server";
import type { AirtimeGateway, AirtimeQuote, AirtimeState, PayoutGateway, PayoutOrderStatus, PayoutQuote } from "@railkit/adapters";

export class ApiError extends UserFacingError {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Droplets: what the savings screen shows. Luna amounts are decimal strings. */
export interface SaveMe {
  network: "mainnet" | "testnet";
  address: string;
  /** e.g. SAVE-7KQ2XMP; null before the user sets a rule. */
  code: string | null;
  /** Share of each payment from an app that's saved; null before the user sets a rule. */
  savePercent: number | null;
  /** Share added on top and saved when the user pays an app; null before the user sets a rule. */
  spendPercent: number | null;
  /** How often Droplets offers to save that share of spending elsewhere; null before the user sets a rule. */
  catchUp: CatchUpEvery | null;
  /** Apps the user allowed to recognise their address, so they save without the code. */
  apps: { id: string; name: string }[];
  blockNumber: number;
  grow: {
    active: string;
    inactive: string;
    inactiveFrom: number | null;
    retired: string;
    delegation: string;
    /** First block the inactive stake can be retired; null when nothing is on its way out. */
    releaseBlock: number | null;
    validatorJailed: boolean;
  } | null;
  /** Why Grow isn't open: no stake yet, or the validator it was delegated to is gone. */
  growClosed: null | "no-stake" | "validator-gone";
  /** What apps sent: "payout" when an app paid the user, "spend" for the part saved when the user paid an app. */
  receipts: { txHash: string; app: string; kind: "wallet" | "grow"; source: "payout" | "spend"; luna: string; at: number }[];
  /** How recent payouts were split, when the paying app said which payout it was. */
  splits: { payoutId: string; app: string; walletLuna: string; growLuna: string; reason: null | "no-stake" | "validator-gone" | "below-minimum"; savePercent: number; at: number }[];
}

/** The savings history, newest first. Amounts are luna; `at` is ms since 1970. */
export interface SaveActivity {
  /**
   * One row per payment an app made to the user's savings or wallet, as checked on-chain. "spend" rows are the part
   * saved when the user paid that app.
   */
  payments: { payoutId: string; app: string; source: "payout" | "spend"; walletLuna: string; growLuna: string; at: number; reason: null | "no-stake" | "validator-gone" | "below-minimum" }[];
  /** The person's own Grow transactions; null when the chain couldn't be read just now. */
  grow: { txHash: string; kind: "opened" | "added" | "withdrawal-started" | "withdrawn"; luna: string; at: number; ok: boolean }[] | null;
}

/**
 * The catch-up: the user's share of what they spent outside apps that save with Droplets, ready to save in one approval.
 * "waiting": the first period hasn't ended. "due": `owed` is still to save. "nothing": nothing to save this time.
 * "done": settled just now. "off": no share to save when paying. `paid` is what the user's own add-stakes have put
 * towards it so far. Luna amounts are decimal strings; times ms since 1970.
 */
export type SaveCatchUp =
  | { status: "off"; every: CatchUpEvery | null; spendPercent: number }
  | { status: "waiting"; every: CatchUpEvery; spendPercent: number; from: number; to: number; next: number }
  | {
      status: "due" | "nothing" | "done"; every: CatchUpEvery; spendPercent: number; from: number; to: number; next: number;
      spent: string; alreadySaved: string; paid: string; owed: string; complete: boolean; growOpen: boolean;
    };

/**
 * A named slice of the user's own savings (their one Nimiq stake). Luna amounts are decimal strings; `dueAt` is
 * midnight UTC on that date, ms since 1970. `locked` means it can't be withdrawn from Droplets right now; `breaking`
 * means the person asked to and is waiting out the cooling-off; `breached` means a withdrawal made outside Droplets
 * reached into it while it was locked.
 */
export interface SaveGoal {
  id: string;
  name: string;
  targetLuna: string | null;
  dueAt: number | null;
  allocatedLuna: string;
  done: boolean;
  locked: boolean;
  breaking: boolean;
  /** When a requested break finishes its cooling-off and the goal is free to withdraw from; null unless breaking. */
  breakReadyAt: number | null;
  breached: boolean;
}

/** The user's goals, reconciled against the chain. Luna amounts are decimal strings. */
export interface SaveGoals {
  totalLuna: string;
  /** What's free to withdraw right now: the total, less whatever sits in a currently locked goal. */
  withdrawableLuna: string;
  goals: SaveGoal[];
  /** When Droplets refuses a new goal until, after a withdrawal outside Droplets reached into a locked one; null if not banned. */
  bannedUntil: number | null;
}

/** An app that saves with Droplets, which the user can allow to recognise their address. */
export interface SaveApp {
  id: string;
  name: string;
  /** Its website or Mini App address, if it gave one. */
  url?: string | null;
}

/** An app signing itself up to save with Droplets. */
export interface SaveAppSignUp {
  name: string;
  /** Its website or Mini App address: https only. Optional. */
  url?: string;
  /** How to reach the developer for the review: never shown publicly. */
  contact: string;
  /** The Nimiq addresses it pays from, 1 to 5. */
  payoutAddresses: string[];
}

/** The key is shown only this once, and works once the app is approved. */
export interface SaveAppKey {
  id: string;
  name: string;
  apiKey: string;
  status: "pending";
}

export interface SaveValidator {
  address: string;
  name: string | null;
  stakeLuna: string;
  numStakers: number;
}

/** One week's draw. Luna amounts are decimal strings; times are ms since 1970. */
export interface PrizeDraw {
  /** The week's Monday, e.g. "2026-11-09". */
  week: string;
  drawAt: number;
  /** The first block made after the draw time: its hash picked the winning ticket. */
  blockNumber: number;
  blockHash: string;
  /** People who qualified. */
  entries: number;
  totalTickets: number;
  winningTicket: number | null;
  /** Shortened, e.g. "NQ12 … AB34"; null when nobody qualified. */
  winner: string | null;
  youWon: boolean;
  prizeLuna: string;
  paid: boolean;
  payoutTx: string | null;
}

/** The weekly draw, for one person. */
export interface PrizeMe {
  rules: { minLuna: string; daysNeeded: number; prizeLuna: string; maxTickets: number; utcOffsetMinutes: number; prizeAddress: string | null };
  joined: boolean;
  /** This week so far; null until the person joins. */
  week: {
    week: string;
    drawAt: number;
    /** Days kept so far, today included while it's still on track. */
    daysKept: number;
    keptLuna: string;
    /** Tickets if the week ended now: 0 until enough days are kept. */
    tickets: number;
    days: { day: string; status: "kept" | "missed" | "today" | "ahead"; lowLuna: string | null }[];
    /** The account has too many transactions this week for its history to be read back. */
    tooManyTransactions: boolean;
  } | null;
  lastDraw: PrizeDraw | null;
  wins: { week: string; drawAt: number; prizeLuna: string; paid: boolean; payoutTx: string | null }[];
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
      throw new ApiError("Can't reach the Droplets server. Check your connection and try again.", 0);
    }
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (res.status === 401) o.onUnauthorized?.();
    if (!res.ok) throw new ApiError(body?.error?.message ?? "the Droplets server had a problem. Try again in a minute.", res.status);
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
    /** One chat turn: Droplets reads the sentence (or the answer to its last question) and says what's still missing. */
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
    /** Droplets: the user's code, rule, Grow balance and payments in. `fresh` skips the server's one-minute stake cache. */
    saveMe: (address: string, fresh = false) => call<SaveMe>(`/v1/save/me?address=${encodeURIComponent(address)}${fresh ? "&fresh=1" : ""}`),
    saveActivity: (address: string) => call<SaveActivity>(`/v1/save/activity?address=${encodeURIComponent(address)}`),
    /** Sets or revokes the rule: the message the user signed in Nimiq Pay, with the key and signature it returned. */
    /** `tzOffsetMinutes` (the phone's time zone) decides when the user's catch-up days, weeks and months start. */
    saveRule: (signed: { message: string; publicKey: string; signature: string; tzOffsetMinutes?: number }) =>
      call<{ code: string; address: string; savePercent: number; spendPercent: number; appIds: string[] } | { revoked: true }>("/v1/save/rule", json(signed)),
    /** The catch-up for the user's spending outside apps that save with Droplets, in their own time zone. */
    saveCatchUp: (address: string, tzOffsetMinutes: number, fresh = false) =>
      call<SaveCatchUp>(`/v1/save/catchup?address=${encodeURIComponent(address)}&tzOffsetMinutes=${tzOffsetMinutes}${fresh ? "&fresh=1" : ""}`),
    /** The apps that save with Droplets, by name. */
    saveApps: async () => (await call<{ apps: SaveApp[] }>("/v1/save/apps")).apps,
    /** Sign an app up. It waits for review; its key works once it's approved. */
    registerSaveApp: (form: SaveAppSignUp) => call<SaveAppKey>("/v1/save/apps/register", json(form)),
    saveValidators: async () => (await call<{ validators: SaveValidator[] }>("/v1/save/validators")).validators,
    /** A question about the user's own savings, answered from their data. `kind` is what the chat already worked out. */
    saveAsk: (req: { address: string; question: string; kind?: SaveQuestion; period?: SavePeriod; tzOffsetMinutes: number }) =>
      call<{ answer: string; question: SaveQuestion; source: "rules" | "model" }>("/v1/save/ask", json(req)),
    /** The user's goals, reconciled against the chain. `creditGoalLuna` (luna) sends a declared top-up there first. */
    saveGoals: (address: string, o: { fresh?: boolean; creditGoalId?: string; creditGoalLuna?: bigint } = {}) =>
      call<SaveGoals>(
        `/v1/save/goals?address=${encodeURIComponent(address)}${o.fresh ? "&fresh=1" : ""}${o.creditGoalId ? `&creditGoal=${encodeURIComponent(o.creditGoalId)}&creditLuna=${o.creditGoalLuna}` : ""}`,
      ),
    /**
     * Create, edit, reorder, delete or break a goal: the message the user signed in Nimiq Pay, with the key and
     * signature. Breaking a goal that costs a fee needs `feeTx`, the hash of a payment already sent for it; without
     * it (or while it's still confirming), the response is `{ pending: true }` and the same call should be retried.
     */
    saveGoalAction: (signed: { message: string; publicKey: string; signature: string }, o: { feeTx?: string } = {}) =>
      call<{ id: string } | { ok: true } | { ok: true; readyAt: number; feeLuna: string } | { pending: true }>("/v1/save/goals", json({ ...signed, ...o })),
    /** The weekly draw: this week for one person, the latest draw and their wins. */
    prizeMe: (address: string) => call<PrizeMe>(`/v1/prize/me?address=${encodeURIComponent(address)}`),
    /** Joins or leaves the draw with the message signed in Nimiq Pay. Joining also sends Nimiq Pay's identifier for the phone. */
    prizeJoin: (signed: { message: string; publicKey: string; signature: string; device?: string }) => call<{ joined: boolean }>("/v1/prize/join", json(signed)),
    banks: async () => (await call<{ banks: { name: string; code: string }[] }>("/v1/payouts/banks?country=NG")).banks,
    nameEnquiry: (accountNumber: string, bankCode: string) =>
      call<{ accountName: string }>(`/v1/payouts/name-enquiry?accountNumber=${encodeURIComponent(accountNumber)}&bankCode=${encodeURIComponent(bankCode)}`),
  };
}

export type RailkitClient = ReturnType<typeof createRailkitClient>;
