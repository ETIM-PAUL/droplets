import type { Money } from "../money";
import type { ParsedPayment } from "../parse";

export type Asset = "NIM" | "USDT";
export type EvmChain = "polygon" | "ethereum" | "arbitrum";
export type HostNetwork = "mainnet" | "testnet";

export interface PayIntent {
  kind: "pay";
  destination: ParsedPayment;
  /** Amount the recipient should get; omitted when the destination fixes it. */
  amount?: Money;
  /** What the user pays with. */
  sourceAsset: Asset;
  /** For payouts to a wallet address: which chain the tokens should arrive on. */
  targetChain?: EvmChain;
}

/** One thing the wallet must do. Wallet adapters (phase 8) implement each kind. */
export type Step =
  | { kind: "pay-lightning-invoice"; invoice: string }
  | { kind: "send-nim"; to: string; amount: Money }
  | { kind: "evm-transfer"; chain: string; to: string; amount: Money };

export interface Quote {
  id: string;
  routeId: string;
  intent: PayIntent;
  /** What leaves the user's wallet, fee included. */
  send: Money;
  /** What the recipient gets. */
  receive: Money;
  fee: Money;
  etaSeconds: number;
  /** Epoch milliseconds. Every quote expires. */
  expiresAt: number;
  steps: Step[];
  /** The provider's own id for this quote, if it has one. */
  providerRef: string | null;
  /** Things the user should know before approving, e.g. that the host dialog shows the final fee. */
  notes?: string[];
}

export type OrderState =
  | "awaiting_approval"
  | "submitting"
  | "outcome_unknown"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export interface TimelineEntry {
  at: number;
  from: OrderState | null;
  to: OrderState;
  note?: string;
}

export interface Order {
  id: string;
  quote: Quote;
  state: OrderState;
  timeline: TimelineEntry[];
  /** One wallet reference (tx hash, swap id, ...) per executed step. */
  stepRefs: string[];
  createdAt: number;
  updatedAt: number;
  /** Shown to the user when the order ends badly: what happened and what to do next. */
  message: string | null;
  /** Set when completed: whether the provider independently confirmed settlement. */
  settlement?: "verified" | "unverified";
}

export type ProviderStatus =
  | { status: "pending" | "processing" }
  | { status: "completed"; verified?: boolean }
  | { status: "failed"; message: string };

export interface RouteAdapter {
  id: string;
  canHandle(intent: PayIntent): boolean;
  quote(intent: PayIntent): Promise<Omit<Quote, "id" | "routeId" | "intent">>;
  /** Called once, when the user approves; lets the provider reserve the order. */
  open(quote: Quote): Promise<{ providerRef: string }>;
  poll(providerRef: string): Promise<ProviderStatus>;
}

/** An error whose message is safe and useful to show the user as written. */
export class UserFacingError extends Error {}

export class WalletError extends Error {
  constructor(
    /** rejected: user declined. unknown: submitted but outcome unclear, never retry. failed: nothing was sent. */
    readonly kind: "rejected" | "unknown" | "failed",
    message: string,
  ) {
    super(message);
  }
}

export interface WalletExecutor {
  execute(step: Step): Promise<{ ref: string }>;
}

export interface OrderStore {
  get(id: string): Promise<Order | undefined>;
  put(order: Order): Promise<void>;
  list(): Promise<Order[]>;
}
