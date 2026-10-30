import type { AirtimeState, PayoutOrderState } from "@railkit/adapters";
import type { RampState } from "@railkit/adapters/server";
import type { OpsState } from "./store";

export const payoutToOps = (s: PayoutOrderState): OpsState =>
  ({ awaiting_payment: "awaiting_payment", paid: "paid", paid_out: "done", failed: "failed", expired: "expired" } as const)[s];

export const airtimeToOps = (s: AirtimeState): OpsState =>
  ({ awaiting_payment: "awaiting_payment", paid: "paid", delivered: "done", failed: "failed" } as const)[s];

/** A top-up on hold counts as paid, so the stuck-order alert fires if the provider never finishes it. */
export const rampToOps = (s: RampState): OpsState =>
  ({ awaiting_payment: "awaiting_payment", processing: "paid", hold: "paid", completed: "done", failed: "failed" } as const)[s];
