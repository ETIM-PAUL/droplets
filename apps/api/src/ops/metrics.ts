import type { OpsOrder } from "./store";

const WEEK = 7 * 86_400_000;

/** The beta numbers the plan asks for: weekly active payers, completed orders per corridor, repeat use, failure rate. */
export function betaMetrics(orders: OpsOrder[], now: number) {
  const done = orders.filter((o) => o.state === "done");
  const paidOutcomes = orders.filter((o) => o.state === "done" || o.state === "failed");
  const perInvite = new Map<string, number>();
  for (const o of done) if (o.invite) perInvite.set(o.invite, (perInvite.get(o.invite) ?? 0) + 1);

  const byProduct: Record<string, number> = {};
  for (const o of done) byProduct[o.product] = (byProduct[o.product] ?? 0) + 1;

  return {
    weeklyActivePayers: new Set(done.filter((o) => o.updatedAt >= now - WEEK && o.invite).map((o) => o.invite)).size,
    payersAllTime: perInvite.size,
    repeatPayers: [...perInvite.values()].filter((n) => n >= 2).length,
    completedOrders: done.length,
    completedByProduct: byProduct,
    failedOrders: orders.filter((o) => o.state === "failed").length,
    /** Failures among orders that were paid, as a fraction; null with no paid orders yet. */
    failedRate: paidOutcomes.length ? orders.filter((o) => o.state === "failed").length / paidOutcomes.length : null,
    inFlight: orders.filter((o) => o.state === "paid").length,
    method: "Counts orders our API quoted and then saw paid and delivered by the provider, grouped by beta invite. One invite is one tester; no bots or scripted wallets.",
  };
}
