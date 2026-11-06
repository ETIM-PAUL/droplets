import { parsePrice, poolDepositMemo, poolPosition, type NimiqTransaction } from "@railkit/core";
import { newDb } from "pg-mem";
import { describe, expect, it, vi } from "vitest";
import { latestState, payPending, poolReserves, settleIfDue, settlementSlot, watchDeposits, type PoolConfig } from "./jobs";
import { MemoryPoolStore, PgPoolStore, type PoolOrderRow, type PoolStore } from "./store";

const POOL = "NQ26 0000 0000 02A5 YAK7 4QNF 9MH0 TE2B GVRU";
const ADA = "NQ23 4CTV GPEU C004 7USS EPFM RQ5C METQ EMDP";
const TUNDE = "NQ49 N8MB XYCR XBUP 404C KXKK L49M A7BT F082";
const NIM = (n: number) => BigInt(n) * 100_000n;
const P0 = parsePrice("0.000278");
const DAY1 = Date.UTC(2026, 10, 4, 12, 5); // five minutes after the 12:00 UTC settlement
const CFG: PoolConfig = {
  poolAddress: POOL, network: "testnet", settleEveryMinutes: 1440, settleAtMinuteUtc: 720, feeBpsPerYear: 0,
  caps: {}, minConfirmations: 60, depositTtlMs: 86_400_000,
};
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");

function chain() {
  const txs: NimiqTransaction[] = [];
  const confirmed = new Set<string>();
  let n = 0;
  return {
    txs,
    confirmed,
    pay: (from: string, luna: bigint, memo: string, confirmations = 60) => {
      const hash = (++n).toString(16).padStart(64, "0");
      txs.unshift({ hash, blockNumber: 1, from, to: POOL, value: luna, recipientData: hex(memo), executionResult: true, confirmations });
      return hash;
    },
    rpc: {
      transactionsByAddress: async () => txs,
      transaction: async (h: string) => (confirmed.has(h) ? ({ hash: h, executionResult: true } as NimiqTransaction) : null),
      balance: async () => txs.filter((t) => t.to === POOL).reduce((a, t) => a + t.value, 0n),
    },
  };
}

const order = (over: Partial<PoolOrderRow> & Pick<PoolOrderRow, "id" | "address" | "side" | "kind">): PoolOrderRow => ({
  expectedLuna: null, luna: null, amount: null, status: "awaiting_payment", txHash: null, note: null, createdAt: DAY1, expiresAt: DAY1 + 86_400_000, queuedAt: null, settledSeq: null, ...over,
});

async function stores(): Promise<[string, () => Promise<PoolStore>][]> {
  return [
    ["memory", async () => new MemoryPoolStore()],
    ["postgres (pg-mem)", async () => {
      const { Pool } = newDb().adapters.createPg();
      const s = new PgPoolStore(new Pool());
      await s.migrate();
      return s;
    }],
  ];
}

describe("the pool's jobs", async () => {
  for (const [name, make] of await stores()) {
    it(`${name}: deposits in, a settlement, a withdrawal out, all the way to confirmed`, async () => {
      const store = await make();
      const c = chain();
      const alert = vi.fn(async () => undefined);
      await store.addOrder(order({ id: "B00STTXNDE", address: TUNDE, side: "boost", kind: "deposit", expectedLuna: NIM(1_000_000).toString() }));
      await store.addOrder(order({ id: "STEADYADA0", address: ADA, side: "steady", kind: "deposit", expectedLuna: NIM(1_000_000).toString() }));
      c.pay("NQ01 REMOTE TUNDE", NIM(1_000_000), poolDepositMemo("boost", "B00STTXNDE"));
      c.pay("NQ01 REMOTE ADA", NIM(1_000_000), poolDepositMemo("steady", "STEADYADA0"));
      c.pay("NQ01 SOMEONE", NIM(5), "hello"); // matches nothing
      c.pay("NQ01 TOO NEW", NIM(5), poolDepositMemo("steady", "STEADYADA0"), 3); // not final yet

      expect(await watchDeposits({ store, rpc: c.rpc, cfg: CFG, now: DAY1, alert })).toEqual({ queued: 2, unmatched: 1, expired: 0 });
      expect(alert).toHaveBeenCalledOnce();
      expect((await store.getOrder("STEADYADA0"))).toMatchObject({ status: "queued", luna: NIM(1_000_000).toString() });

      // Not due until the next 12:00 UTC... the first settlement is due at once, since there's none yet.
      const first = await settleIfDue({ store, prices: async () => [{ name: "a", price: P0 }, { name: "b", price: P0 }], cfg: CFG, now: DAY1 });
      expect(first).toMatchObject({ settled: true, seq: 1 });
      expect(await settleIfDue({ store, prices: async () => [], cfg: CFG, now: DAY1 + 60_000 })).toEqual({ settled: false, reason: "not due" });
      expect((await store.getOrder("STEADYADA0"))!.status).toBe("filled");

      // Day 2: NIM is down 20%. Ada takes everything out: $278 is 1,250,000 NIM now.
      await store.addOrder(order({ id: "W1THDRAWAD", address: ADA, side: "steady", kind: "withdraw", status: "queued", createdAt: DAY1 + 3600_000, queuedAt: DAY1 + 3600_000 }));
      const day2 = DAY1 + 86_400_000;
      await settleIfDue({ store, prices: async () => [{ name: "a", price: (P0 * 8n) / 10n }, { name: "b", price: (P0 * 8n) / 10n }], cfg: CFG, now: day2 });
      const [payout] = await store.payoutsByStatus("pending");
      expect(payout).toMatchObject({ address: ADA, luna: NIM(1_250_000).toString(), reason: "withdrawal" });
      const s = await latestState(store);
      expect(poolPosition(s, TUNDE, s.price).boostLuna).toBe(NIM(750_000));

      const pay = vi.fn(async () => ({ walletTx: "f".repeat(64) }));
      expect(await payPending({ store, rpc: c.rpc, pay, now: day2 })).toEqual({ sent: 1, confirmed: 0, failed: 0 });
      expect(pay).toHaveBeenCalledWith({ to: ADA, luna: NIM(1_250_000), payoutId: payout!.id, memo: "Errand pool withdrawal" });
      c.confirmed.add("f".repeat(64));
      expect(await payPending({ store, rpc: c.rpc, pay, now: day2 + 60_000 })).toEqual({ sent: 0, confirmed: 1, failed: 0 });
      expect(pay).toHaveBeenCalledOnce();

      const reserves = await poolReserves({ store, rpc: { balance: async () => NIM(2_000_010) - NIM(1_250_000) }, cfg: CFG });
      expect(reserves.owedLuna).toBe(NIM(750_000));
      expect(reserves.surplusLuna).toBe(NIM(10)); // the unmatched 5 NIM and the not-yet-final 5 NIM, held for review
    });

    it(`${name}: a settlement interrupted halfway is finished next time, never applied twice`, async () => {
      const store = await make();
      const c = chain();
      await store.addOrder(order({ id: "B00STTXNDE", address: TUNDE, side: "boost", kind: "deposit" }));
      c.pay("NQ01 X", NIM(100), poolDepositMemo("boost", "B00STTXNDE"));
      await watchDeposits({ store, rpc: c.rpc, cfg: CFG, now: DAY1 });
      // The worker dies right after writing the settlement, before marking the order filled.
      const updateOrder = store.updateOrder.bind(store);
      let calls = 0;
      store.updateOrder = async (id, patch) => {
        if (patch.status === "filled" && calls++ === 0) throw new Error("killed");
        return updateOrder(id, patch);
      };
      const prices = async () => [{ name: "a", price: P0 }, { name: "b", price: P0 }];
      await expect(settleIfDue({ store, prices, cfg: CFG, now: DAY1 })).rejects.toThrow("killed");
      expect((await store.getOrder("B00STTXNDE"))!.status).toBe("queued");
      // Next round: it's finished first, and the next day's settlement doesn't apply the deposit again.
      await settleIfDue({ store, prices, cfg: CFG, now: DAY1 + 60_000 });
      expect((await store.getOrder("B00STTXNDE"))!.status).toBe("filled");
      await settleIfDue({ store, prices, cfg: CFG, now: DAY1 + 86_400_000 });
      const s = await latestState(store);
      expect(s.seq).toBe(2);
      expect(s.poolLuna).toBe(NIM(100));
    });

    it(`${name}: pauses on a bad price and says so once per settlement`, async () => {
      const store = await make();
      const alert = vi.fn(async () => undefined);
      const one = async () => [{ name: "a", price: P0 }];
      expect(await settleIfDue({ store, prices: one, cfg: CFG, now: DAY1, alert })).toMatchObject({ settled: false, reason: expect.stringMatching(/at least 2/) });
      await settleIfDue({ store, prices: one, cfg: CFG, now: DAY1 + 60_000, alert });
      expect(alert).toHaveBeenCalledOnce();
      await store.setSetting("paused", "true");
      expect(await settleIfDue({ store, prices: async () => [{ name: "a", price: P0 }, { name: "b", price: P0 }], cfg: CFG, now: DAY1 })).toEqual({ settled: false, reason: "paused" });
    });

    it(`${name}: expires an unpaid deposit order, and still takes a late payment`, async () => {
      const store = await make();
      const c = chain();
      await store.addOrder(order({ id: "2ATEPAYER0", address: ADA, side: "boost", kind: "deposit", expiresAt: DAY1 + 1 }));
      expect((await watchDeposits({ store, rpc: c.rpc, cfg: CFG, now: DAY1 + 2 })).expired).toBe(1);
      c.pay("NQ01 X", NIM(3), poolDepositMemo("boost", "2ATEPAYER0"));
      await watchDeposits({ store, rpc: c.rpc, cfg: CFG, now: DAY1 + 3 });
      expect((await store.getOrder("2ATEPAYER0"))!.status).toBe("queued");
    });
  }
});

describe("payouts that don't land", () => {
  it("are resent after 10 minutes with one alert, and fail with another once they expire", async () => {
    const store = new MemoryPoolStore();
    await store.addPayout({ id: "1:X", orderId: "X", address: ADA, luna: "100", reason: "withdrawal", status: "pending", txHash: null, record: null, createdAt: DAY1, updatedAt: DAY1 });
    const rpc = { transaction: async () => null };
    const alert = vi.fn(async () => undefined);
    const pay = vi.fn(async () => ({ walletTx: "a".repeat(64) }));
    await payPending({ store, rpc, pay, now: DAY1, alert });
    await payPending({ store, rpc, pay, now: DAY1 + 5 * 60_000, alert });
    expect(pay).toHaveBeenCalledTimes(1);
    await payPending({ store, rpc, pay, now: DAY1 + 11 * 60_000, alert });
    await payPending({ store, rpc, pay, now: DAY1 + 22 * 60_000, alert });
    expect(pay).toHaveBeenCalledTimes(3);
    expect(alert).toHaveBeenCalledTimes(1);
    pay.mockRejectedValueOnce(new Error("Payout 1:X was signed but never confirmed, and has expired. Check before paying again."));
    await payPending({ store, rpc, pay, now: DAY1 + 3 * 3600_000, alert });
    expect((await store.getPayout("1:X"))!.status).toBe("failed");
    expect(alert).toHaveBeenCalledTimes(2);
  });
});

describe("settlement slots", () => {
  it("line up to 12:00 UTC daily, or to shorter steps for testing", () => {
    expect(settlementSlot(DAY1, CFG)).toBe(Date.UTC(2026, 10, 4, 12));
    expect(settlementSlot(Date.UTC(2026, 10, 4, 11, 59), CFG)).toBe(Date.UTC(2026, 10, 3, 12));
    expect(settlementSlot(Date.UTC(2026, 10, 4, 12, 44), { settleEveryMinutes: 30, settleAtMinuteUtc: 0 })).toBe(Date.UTC(2026, 10, 4, 12, 30));
  });
});

describe("pool settings from the environment", () => {
  it("is off unless switched on, and refuses mainnet without the second switch", async () => {
    const { poolConfigFromEnv } = await import("./config");
    expect(poolConfigFromEnv({})).toBeNull();
    const on = { POOL_ENABLED: "true", POOL_ADDRESS: POOL };
    expect(poolConfigFromEnv(on)).toMatchObject({ network: "testnet", settleEveryMinutes: 1440, settleAtMinuteUtc: 720, feeBpsPerYear: 100, caps: { maxSteadyUsdPerAddress: 100_000_000n } });
    expect(() => poolConfigFromEnv({ ...on, POOL_NETWORK: "mainnet" })).toThrow(/POOL_ALLOW_MAINNET/);
    expect(poolConfigFromEnv({ ...on, POOL_NETWORK: "mainnet", POOL_ALLOW_MAINNET: "true" })!.network).toBe("mainnet");
    expect(() => poolConfigFromEnv({ ...on, POOL_ADDRESS: "nope" })).toThrow(/POOL_ADDRESS/);
    expect(() => poolConfigFromEnv({ ...on, POOL_SETTLE_EVERY_MINUTES: "1" })).toThrow(/at least 5/);
    expect(poolConfigFromEnv({ ...on, POOL_MAX_STEADY_USD_TOTAL: "none" })!.caps.maxSteadyUsdTotal).toBeUndefined();
  });
});
