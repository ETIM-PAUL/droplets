import type { Order, OrderState } from "./types";

const NEXT: Record<OrderState, readonly OrderState[]> = {
  awaiting_approval: ["submitting", "cancelled", "expired"],
  submitting: ["processing", "outcome_unknown", "cancelled", "failed"],
  outcome_unknown: ["processing", "failed"],
  processing: ["completed", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
};

export const isTerminal = (s: OrderState): boolean => NEXT[s].length === 0;
export const canTransition = (from: OrderState, to: OrderState): boolean => NEXT[from].includes(to);

/** Returns a new order in `to`, with the move recorded on its timeline. Throws on an illegal move. */
export function transition(order: Order, to: OrderState, now: number, note?: string, message?: string): Order {
  if (!canTransition(order.state, to)) {
    throw new Error(`Illegal order transition ${order.state} -> ${to} (order ${order.id})`);
  }
  return {
    ...order,
    state: to,
    updatedAt: now,
    message: message ?? order.message,
    timeline: [...order.timeline, { at: now, from: order.state, to, ...(note ? { note } : {}) }],
  };
}

export interface StuckLimits {
  submittingMs: number;
  /** Multiple of the quoted ETA after which a processing order is stuck. */
  processingEtaFactor: number;
  processingGraceMs: number;
}

export const DEFAULT_LIMITS: StuckLimits = { submittingMs: 120_000, processingEtaFactor: 3, processingGraceMs: 60_000 };

/** Why an order needs attention, or null. Drives the stuck-order alert. */
export function stuckReason(order: Order, now: number, limits: StuckLimits = DEFAULT_LIMITS): string | null {
  const age = now - (order.timeline.at(-1)?.at ?? order.createdAt);
  switch (order.state) {
    case "outcome_unknown":
      return "Payment outcome unknown: needs reconciliation before any retry";
    case "submitting":
      return age > limits.submittingMs ? "Stuck submitting to the wallet" : null;
    case "processing":
      return age > order.quote.etaSeconds * 1000 * limits.processingEtaFactor + limits.processingGraceMs
        ? "Provider is taking much longer than quoted"
        : null;
    default:
      return null;
  }
}
