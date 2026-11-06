import {
  choosePrice,
  GENESIS,
  poolStateFromJson,
  poolStateToJson,
  poolTotals,
  readPoolDepositMemo,
  settle,
  type NimiqRpc,
  type OrderResult,
  type PoolOrder,
  type PoolPayout,
  type PoolState,
  type PriceSource,
  type SettleConfig,
} from "@railkit/core";
import type { PoolOrderRow, PoolStore } from "./store";

export interface PoolConfig {
  /** The pool's own address: deposits go here, payouts come from here. */
  poolAddress: string;
  network: "mainnet" | "testnet";
  /** 1440 for daily settlements; shorter on testnet to try it out. */
  settleEveryMinutes: number;
  /** Minutes after 00:00 UTC that settlements line up to; 720 is 12:00 UTC. */
  settleAtMinuteUtc: number;
  feeBpsPerYear: number;
  caps: Pick<SettleConfig, "maxSteadyUsdPerAddress" | "maxSteadyUsdTotal" | "maxBoostLunaPerAddress">;
  /** A deposit counts once it's this deep (60 blocks is past the next macro block, so final). */
  minConfirmations: number;
  /** How long a deposit order waits for its payment before it's marked expired. A late payment still counts. */
  depositTtlMs: number;
}

/** The latest settlement time at or before `now`. */
export function settlementSlot(now: number, cfg: Pick<PoolConfig, "settleEveryMinutes" | "settleAtMinuteUtc">): number {
  const every = cfg.settleEveryMinutes * 60_000;
  const offset = (cfg.settleAtMinuteUtc * 60_000) % every;
  return Math.floor((now - offset) / every) * every + offset;
}
export const nextSettlementAt = (now: number, cfg: Pick<PoolConfig, "settleEveryMinutes" | "settleAtMinuteUtc">) => settlementSlot(now, cfg) + cfg.settleEveryMinutes * 60_000;

/** Everything a settlement decided. Kept whole, so a crash halfway through recording it can be finished later. */
export interface Settlement {
  state: PoolState;
  results: OrderResult[];
  payouts: PoolPayout[];
  sources: PriceSource[];
  wipedOut: boolean;
}

const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
export const settlementToJson = (s: Settlement) => JSON.stringify({ ...s, state: poolStateToJson(s.state) }, big);
export function settlementFromJson(json: string): Settlement {
  const j = JSON.parse(json) as { state: string; results: OrderResult[]; payouts: (Omit<PoolPayout, "luna"> & { luna: string })[]; sources: { name: string; price: string }[]; wipedOut: boolean };
  return {
    state: poolStateFromJson(j.state),
    results: j.results,
    payouts: j.payouts.map((p) => ({ ...p, luna: BigInt(p.luna) })),
    sources: j.sources.map((x) => ({ name: x.name, price: BigInt(x.price) })),
    wipedOut: j.wipedOut,
  };
}

export async function latestState(store: PoolStore): Promise<PoolState> {
  const row = await store.latestSettlement();
  return row ? settlementFromJson(row.json).state : GENESIS;
}

const toOrder = (o: PoolOrderRow): PoolOrder | null => {
  const at = o.queuedAt ?? o.createdAt;
  if (o.kind === "deposit") return o.luna ? { id: o.id, kind: "deposit", side: o.side, address: o.address, luna: BigInt(o.luna), at } : null;
  return { id: o.id, kind: "withdraw", side: o.side, address: o.address, amount: o.amount === null ? null : BigInt(o.amount), at };
};

const utf8 = (hex: string) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16)));
  } catch {
    return "";
  }
};

/**
 * Turns payments into the pool into queued deposits, matched by the memo on each payment. Only final payments
 * count. Anything that doesn't match an open order is set aside for a person to refund.
 */
export async function watchDeposits(d: { store: PoolStore; rpc: Pick<NimiqRpc, "transactionsByAddress">; cfg: PoolConfig; now: number; alert?: (t: string) => Promise<void> }) {
  const out = { queued: 0, unmatched: 0, expired: 0 };
  for (const tx of await d.rpc.transactionsByAddress(d.cfg.poolAddress, 100)) {
    if (tx.to !== d.cfg.poolAddress || !tx.executionResult || tx.confirmations < d.cfg.minConfirmations) continue;
    if (await d.store.orderByTx(tx.hash)) continue;
    const memo = utf8(tx.recipientData);
    const ref = readPoolDepositMemo(memo);
    const order = ref && (await d.store.getOrder(ref.orderId));
    if (order && order.kind === "deposit" && order.side === ref.side && (order.status === "awaiting_payment" || order.status === "expired") && !order.txHash) {
      await d.store.updateOrder(order.id, { status: "queued", luna: tx.value.toString(), txHash: tx.hash, queuedAt: d.now });
      out.queued++;
    } else if (await d.store.addUnmatched({ txHash: tx.hash, from: tx.from, luna: tx.value.toString(), memo: memo.slice(0, 80), seenAt: d.now })) {
      out.unmatched++;
      await d.alert?.(`POOL: a payment matched no open order and needs a refund by hand: ${tx.hash} (${tx.value} luna from ${tx.from})`).catch(() => undefined);
    }
  }
  for (const o of await d.store.ordersByStatus("awaiting_payment")) {
    if (o.expiresAt !== null && d.now > o.expiresAt) {
      await d.store.updateOrder(o.id, { status: "expired", note: "No payment arrived. If you paid later, it still counts." });
      out.expired++;
    }
  }
  return out;
}

/** Writes a settlement's results to the orders and its payouts to the queue. Safe to run again: nothing is applied twice. */
export async function recordSettlement(store: PoolStore, s: Settlement, now: number) {
  for (const r of s.results) {
    const o = await store.getOrder(r.id);
    if (!o || o.status !== "queued") continue;
    if (r.status === "waiting") await store.updateOrder(r.id, { note: r.reason });
    else await store.updateOrder(r.id, { status: r.status, settledSeq: s.state.seq, note: "reason" in r ? r.reason : null });
  }
  for (const p of s.payouts) {
    await store.addPayout({ id: p.id, orderId: p.orderId, address: p.address, luna: p.luna.toString(), reason: p.reason, status: "pending", txHash: null, record: null, createdAt: now, updatedAt: now });
  }
}

/**
 * Settles once a slot has come round: finishes recording the last settlement if a crash interrupted it,
 * picks the price (or pauses), applies every queued order at that price, and records the result.
 */
export async function settleIfDue(d: { store: PoolStore; prices: () => Promise<PriceSource[]>; cfg: PoolConfig; now: number; alert?: (t: string) => Promise<void>; log?: (m: string, x?: Record<string, unknown>) => void }) {
  const last = await d.store.latestSettlement();
  const prev = last ? settlementFromJson(last.json) : null;
  if (prev) await recordSettlement(d.store, prev, d.now);
  const slot = settlementSlot(d.now, d.cfg);
  if (last && last.at >= slot) return { settled: false as const, reason: "not due" };
  if ((await d.store.getSetting("paused")) === "true") return { settled: false as const, reason: "paused" };

  const state = prev?.state ?? GENESIS;
  const sources = await d.prices();
  const price = choosePrice(sources, state.price);
  if (!price.ok) {
    // Once per slot: the next try is a minute later anyway.
    if ((await d.store.getSetting("price-alert-slot")) !== String(slot)) {
      await d.store.setSetting("price-alert-slot", String(slot));
      await d.alert?.(`POOL: settlement paused. ${price.reason}`).catch(() => undefined);
    }
    return { settled: false as const, reason: price.reason };
  }

  const applied = new Set(state.appliedOrders);
  const orders = (await d.store.ordersByStatus("queued")).filter((o) => !applied.has(o.id)).map(toOrder).filter((o): o is PoolOrder => o !== null);
  const r = settle(state, orders, price.price, slot, { feeBpsPerYear: d.cfg.feeBpsPerYear, settlementsPerYear: Math.round((365 * 1440) / d.cfg.settleEveryMinutes), ...d.cfg.caps });
  const record: Settlement = { state: r.state, results: r.results, payouts: r.payouts, sources, wipedOut: r.wipedOut };
  if (!(await d.store.addSettlement({ seq: r.state.seq, at: slot, json: settlementToJson(record) }))) return { settled: false as const, reason: "another worker settled first" };
  await recordSettlement(d.store, record, d.now);
  d.log?.("pool settled", { seq: r.state.seq, price: price.price.toString(), orders: orders.length, payouts: r.payouts.length, coverBps: r.totals.coverBps, wipedOut: r.wipedOut });
  if (r.wipedOut) await d.alert?.(`POOL: NIM fell past Boost's cover at settlement ${r.state.seq}. Steady shared the pool and Boost was wiped out.`).catch(() => undefined);
  return { settled: true as const, seq: r.state.seq, totals: r.totals };
}

/** Sends what the pool owes. `pay` signs with the pool's key in the worker; a retry resends the same transaction. */
export async function payPending(d: {
  store: PoolStore;
  rpc: Pick<NimiqRpc, "transaction">;
  pay: (p: { to: string; luna: bigint; payoutId: string; memo: string }) => Promise<{ walletTx: string | null }>;
  now: number;
  alert?: (t: string) => Promise<void>;
}) {
  const out = { sent: 0, confirmed: 0, failed: 0 };
  const attempt = async (id: string, address: string, luna: string, reason: string) => {
    try {
      const r = await d.pay({ to: address, luna: BigInt(luna), payoutId: id, memo: reason === "refund" ? "Errand pool refund" : "Errand pool withdrawal" });
      await d.store.updatePayout(id, { status: "sent", txHash: r.walletTx, updatedAt: d.now });
      out.sent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/expired/i.test(msg)) {
        await d.store.updatePayout(id, { status: "failed", updatedAt: d.now });
        out.failed++;
        await d.alert?.(`POOL: payout ${id} expired unsent. Check the pool's history before paying ${luna} luna to ${address} by hand.`).catch(() => undefined);
      }
      // Anything else (network, node busy) is tried again next round with the same signed transaction.
    }
  };
  for (const p of await d.store.payoutsByStatus("pending")) await attempt(p.id, p.address, p.luna, p.reason);
  for (const p of await d.store.payoutsByStatus("sent")) {
    const tx = p.txHash ? await d.rpc.transaction(p.txHash).catch(() => null) : null;
    if (tx?.executionResult) {
      await d.store.updatePayout(p.id, { status: "confirmed", updatedAt: d.now });
      out.confirmed++;
    } else if (tx && !tx.executionResult) {
      await d.store.updatePayout(p.id, { status: "failed", updatedAt: d.now });
      out.failed++;
      await d.alert?.(`POOL: payout ${p.id} failed on-chain (${p.txHash}). Pay ${p.luna} luna to ${p.address} by hand.`).catch(() => undefined);
    } else if (d.now - p.updatedAt > 10 * 60_000) {
      // A node can accept a transaction that never lands (seen on testnet: a payout from an empty pool).
      // Resend the same signed transaction; once it expires, attempt() marks it failed and alerts.
      if ((await d.store.getSetting(`payout-alert:${p.id}`)) !== "sent") {
        await d.store.setSetting(`payout-alert:${p.id}`, "sent");
        await d.alert?.(`POOL: payout ${p.id} (${p.luna} luna) isn't on-chain after 10 minutes. Resending. Is the pool funded? Check /v1/pool/reserves.`).catch(() => undefined);
      }
      await attempt(p.id, p.address, p.luna, p.reason);
    }
  }
  return out;
}

/** The pool's NIM on-chain against everything it owes, so anyone can check the books are covered. */
export async function poolReserves(d: { store: PoolStore; rpc: Pick<NimiqRpc, "balance">; cfg: Pick<PoolConfig, "poolAddress"> }) {
  const state = await latestState(d.store);
  const [onChain, pending, sent, queued] = await Promise.all([
    d.rpc.balance(d.cfg.poolAddress),
    d.store.payoutsByStatus("pending"),
    d.store.payoutsByStatus("sent"),
    d.store.ordersByStatus("queued"),
  ]);
  const unpaid = [...pending, ...sent].reduce((a, p) => a + BigInt(p.luna), 0n);
  const deposits = queued.filter((o) => o.kind === "deposit" && o.luna).reduce((a, o) => a + BigInt(o.luna!), 0n);
  const owed = state.poolLuna + state.feeLuna + unpaid + deposits;
  return {
    poolAddress: d.cfg.poolAddress,
    onChainLuna: onChain,
    owedLuna: owed,
    surplusLuna: onChain - owed,
    breakdown: { steadyAndBoostLuna: state.poolLuna, feeLuna: state.feeLuna, unpaidPayoutLuna: unpaid, unsettledDepositLuna: deposits },
    totals: state.price > 0n ? poolTotals(state, state.price) : null,
    lastSettlement: { seq: state.seq, at: state.at },
  };
}
