import type { OpsOrder, OpsState, OpsStore } from "./store";

export interface WatchDeps {
  store: OpsStore;
  /** Asks the provider where an order is, mapped to our states. */
  refresh: (o: OpsOrder) => Promise<OpsState | null>;
  alert: (text: string) => Promise<void>;
  now?: () => number;
  /** How long a paid order may take before someone should look. */
  stuckAfterMs?: Record<OpsOrder["kind"], number>;
  /** Cap on provider calls per pass, to stay inside shared rate limits. */
  maxRefreshes?: number;
}

// Card and bank top-ups can sit in the provider's checks for a while before NIM is sent.
const DEFAULT_STUCK = { payout: 30 * 60_000, airtime: 15 * 60_000, topup: 90 * 60_000 };

const describe = (o: OpsOrder) =>
  `${o.kind} ${o.id} (${o.receiveAmount} ${o.receiveCurrency}, ${o.sats} sats, ${o.product}, invite ${o.invite ?? "none"})`;

/**
 * One pass over recent orders: catch payments made after the app closed, flag orders stuck after payment,
 * and flag failures after payment, which need a manual refund. Each order alerts at most once.
 */
export async function watchOnce(d: WatchDeps): Promise<{ refreshed: number; alerts: number }> {
  const now = (d.now ?? Date.now)();
  const stuckAfter = d.stuckAfterMs ?? DEFAULT_STUCK;
  let budget = d.maxRefreshes ?? 20;
  let alerts = 0;
  const recent = await d.store.listSince(now - 3 * 86_400_000);

  for (const o of recent) {
    let state = o.state;
    let changedAt = o.updatedAt;
    const live = state === "paid" || (state === "awaiting_payment" && now < o.expiresAt + 15 * 60_000);

    if (live && budget > 0) {
      budget--;
      const next = await d.refresh(o).catch(() => null);
      if (next && next !== state) {
        await d.store.setState(o.id, next, now);
        state = next;
        changedAt = now;
      }
    }
    if (state === "awaiting_payment" && now >= o.expiresAt + 15 * 60_000) {
      await d.store.setState(o.id, "expired", now); // never paid: nothing to chase
      continue;
    }
    if (o.alertedAt !== null) continue;

    let reason: string | null = null;
    if (state === "paid" && now - changedAt > stuckAfter[o.kind]) {
      reason = `STUCK: paid but not delivered after ${Math.round((now - changedAt) / 60_000)} min: ${describe(o)}`;
    } else if (state === "failed") {
      // We may not have seen the payment ourselves, so treat every failure as a possible refund.
      reason = `CHECK REFUND: order failed, the user may have paid: ${describe(o)}`;
    }
    if (reason) {
      await d.alert(reason).catch(() => undefined);
      await d.store.markAlerted(o.id, now);
      alerts++;
    }
  }
  return { refreshed: (d.maxRefreshes ?? 20) - budget, alerts };
}

/** Posts to a Slack- or Discord-style incoming webhook; logs when none is set. */
export function webhookAlerter(url: string | undefined, log: (m: string) => void = console.error) {
  return async (text: string) => {
    log(JSON.stringify({ msg: "alert", text }));
    if (!url) return;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(10_000),
    });
  };
}
