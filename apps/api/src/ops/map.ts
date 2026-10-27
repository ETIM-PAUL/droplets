import type { AirtimeState, PayoutOrderState } from "@railkit/adapters";
import type { OpsState } from "./store";

export const payoutToOps = (s: PayoutOrderState): OpsState =>
  ({ awaiting_payment: "awaiting_payment", paid: "paid", paid_out: "done", failed: "failed", expired: "expired" } as const)[s];

export const airtimeToOps = (s: AirtimeState): OpsState =>
  ({ awaiting_payment: "awaiting_payment", paid: "paid", delivered: "done", failed: "failed" } as const)[s];
