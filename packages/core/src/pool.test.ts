import { describe, expect, it } from "vitest";
import {
  choosePrice,
  formatPoolWithdrawMessage,
  parsePoolWithdrawMessage,
  poolDepositMemo,
  readPoolDepositMemo,
  formatUsd,
  GENESIS,
  lunaToUsd,
  parsePrice,
  parseUsd,
  poolPosition,
  poolStateFromJson,
  poolStateToJson,
  poolTotals,
  settle,
  usdToLuna,
  type PoolOrder,
  type PoolState,
  type SettleConfig,
} from "./pool";

const NIM = (n: number) => BigInt(Math.round(n * 100_000));
const P0 = parsePrice("0.000278");
const NO_FEE: SettleConfig = { feeBpsPerYear: 0, settlementsPerYear: 365 };
const ADA = "NQ23 4CTV GPEU C004 7USS EPFM RQ5C METQ EMDP";
const TUNDE = "NQ49 N8MB XYCR XBUP 404C KXKK L49M A7BT F082";
let n = 0;
const deposit = (address: string, side: "steady" | "boost", luna: bigint): PoolOrder => ({ id: `o${++n}`, kind: "deposit", side, address, luna, at: n });
const withdraw = (address: string, side: "steady" | "boost", amount: bigint | null): PoolOrder => ({ id: `o${++n}`, kind: "withdraw", side, address, amount, at: n });

/** Ada saves 1,000,000 NIM ($278) in Steady; Tunde puts 1,000,000 NIM in Boost. */
function adaAndTunde() {
  return settle(GENESIS, [deposit(ADA, "steady", NIM(1_000_000)), deposit(TUNDE, "boost", NIM(1_000_000))], P0, 1, NO_FEE);
}

describe("the plan's example", () => {
  it("takes both deposits, Boost first, so Steady has cover", () => {
    const r = adaAndTunde();
    expect(r.results.map((x) => x.status)).toEqual(["filled", "filled"]);
    expect(formatUsd(r.state.steady[ADA]!)).toBe("278.00");
    expect(r.totals).toMatchObject({ claimLuna: NIM(1_000_000), boostLuna: NIM(1_000_000), coverBps: 10_000 });
  });

  it("keeps Ada at $278 and gives Tunde twice the move, either way", () => {
    const start = adaAndTunde().state;
    const down = settle(start, [], (P0 * 8n) / 10n, 2, NO_FEE).state;
    expect(poolPosition(down, ADA, down.price)).toMatchObject({ steadyUsd: start.steady[ADA], steadyLuna: NIM(1_250_000) });
    expect(poolPosition(down, TUNDE, down.price).boostLuna).toBe(NIM(750_000));
    expect(lunaToUsd(NIM(750_000), down.price) * 100n / lunaToUsd(NIM(1_000_000), P0)).toBe(60n); // down 40%

    const up = settle(start, [], (P0 * 12n) / 10n, 2, NO_FEE).state;
    expect(poolPosition(up, ADA, up.price).steadyLuna).toBe(83_333_333_333n); // 833,333.33333 NIM
    expect(poolPosition(up, TUNDE, up.price).boostLuna).toBe(116_666_666_667n);
    expect(lunaToUsd(116_666_666_667n, up.price) * 100n / lunaToUsd(NIM(1_000_000), P0)).toBe(140n); // up 40%
    expect(poolPosition(start, TUNDE, P0).boostLeveragePct).toBe(200);
  });
});

describe("a crash beyond cover", () => {
  it("lets Steady share the whole pool and wipes Boost out", () => {
    const start = adaAndTunde().state;
    const r = settle(start, [], (P0 * 4n) / 10n, 2, NO_FEE); // down 60%: Steady would be owed 2.5M NIM of 2M
    expect(r.wipedOut).toBe(true);
    expect(r.state.boost).toEqual({});
    expect(r.state.boostShares).toBe(0n);
    expect(usdToLuna(r.state.steady[ADA]!, r.state.price)).toBeLessThanOrEqual(NIM(2_000_000));
    expect(usdToLuna(r.state.steady[ADA]!, r.state.price)).toBeGreaterThan(NIM(1_999_999));
    // A new Boost deposit afterwards owns only its own NIM, not the old (worthless) shares' history.
    const next = settle(r.state, [deposit(TUNDE, "boost", NIM(10))], r.state.price, 3, NO_FEE).state;
    expect(poolPosition(next, TUNDE, next.price).boostLuna).toBeLessThanOrEqual(NIM(10));
  });
});

describe("orders", () => {
  it("refuses Steady deposits that Boost can't cover, and refunds them", () => {
    const r = settle(GENESIS, [deposit(ADA, "steady", NIM(1000))], P0, 1, NO_FEE);
    expect(r.results[0]).toMatchObject({ status: "refunded", luna: NIM(1000), reason: expect.stringMatching(/enough Boost/) });
    expect(r.payouts).toEqual([{ id: "1:" + r.results[0]!.id, orderId: r.results[0]!.id, address: ADA, luna: NIM(1000), reason: "refund" }]);
    expect(r.state.poolLuna).toBe(0n);
  });

  it("pays Steady withdrawals at the settlement price, in part or all", () => {
    const start = adaAndTunde().state;
    const half = settle(start, [withdraw(ADA, "steady", parseUsd("139")!)], P0, 2, NO_FEE);
    expect(half.payouts[0]).toMatchObject({ address: ADA, luna: NIM(500_000), reason: "withdrawal" });
    expect(formatUsd(half.state.steady[ADA]!)).toBe("139.00");
    const all = settle(half.state, [withdraw(ADA, "steady", null)], (P0 * 8n) / 10n, 3, NO_FEE);
    expect(all.payouts[0]!.luna).toBe(NIM(625_000)); // $139 at the lower price is more NIM
    expect(all.state.steady[ADA]).toBeUndefined();
    expect(settle(all.state, [withdraw(ADA, "steady", null)], P0, 4, NO_FEE).results[0]!.status).toBe("rejected");
  });

  it("holds a Boost withdrawal while Steady needs the cover, and pays it once Steady is gone", () => {
    const start = adaAndTunde().state;
    const held = settle(start, [withdraw(TUNDE, "boost", null)], P0, 2, NO_FEE);
    expect(held.results[0]!.status).toBe("waiting");
    expect(held.state.appliedOrders).toEqual([]);
    const order = withdraw(TUNDE, "boost", null);
    const after = settle(held.state, [withdraw(ADA, "steady", null), order], P0, 3, NO_FEE);
    expect(after.results.find((x) => x.id === order.id)).toMatchObject({ status: "filled", luna: NIM(1_000_000) });
    expect(after.state.poolLuna).toBe(0n);
  });

  it("refunds deposits over the pilot's caps", () => {
    const cfg: SettleConfig = { ...NO_FEE, maxSteadyUsdPerAddress: parseUsd("100")!, maxBoostLunaPerAddress: NIM(500_000) };
    const r = settle(GENESIS, [deposit(TUNDE, "boost", NIM(600_000)), deposit(ADA, "steady", NIM(1_000_000))], P0, 1, cfg);
    expect(r.results.map((x) => [x.status, x.status === "refunded" ? x.reason : ""])).toEqual([
      ["refunded", "That would take your Boost over the pilot's limit."],
      ["refunded", "That would take your Steady over the pilot's limit."],
    ]);
  });
});

describe("fees", () => {
  it("takes the yearly rate a day at a time from both sides", () => {
    const start = adaAndTunde().state;
    const r = settle(start, [], P0, 2, { feeBpsPerYear: 100, settlementsPerYear: 365 });
    expect(r.state.steady[ADA]).toBe(start.steady[ADA]! - (start.steady[ADA]! * 100n) / 3_650_000n);
    expect(r.feeLuna).toBeGreaterThan(0n);
    expect(r.state.feeLuna).toBe(r.feeLuna);
    expect(r.state.poolLuna + r.state.feeLuna).toBe(start.poolLuna);
  });
});

describe("never creates or loses NIM", () => {
  it("over 300 random settlements, everything in is paid out, still held, or a fee; Steady can always be paid", () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    const people = [ADA, TUNDE, "NQ07 0000 0000 0000 0000 0000 0000 0000 0000", "NQ54 0171 C045 GY82 67CU GTUD M39R HR52 P9FS"];
    let state: PoolState = GENESIS;
    let price = P0;
    let deposited = 0n;
    let paid = 0n;
    let waiting: PoolOrder[] = [];
    for (let day = 1; day <= 300; day++) {
      price = (price * BigInt(Math.round(800 + rand() * 450))) / 1000n; // -20% to +25% a day
      if (price < 1_000n) price = 1_000n;
      const orders: PoolOrder[] = [...waiting];
      for (let k = 0; k < 3; k++) {
        const who = people[Math.floor(rand() * people.length)]!;
        const side = rand() < 0.5 ? "steady" : "boost";
        if (rand() < 0.6) {
          const o = deposit(who, side, BigInt(Math.floor(rand() * 5e10)) + 1n);
          deposited += o.kind === "deposit" ? o.luna : 0n;
          orders.push(o);
        } else orders.push(withdraw(who, side, rand() < 0.5 ? null : BigInt(Math.floor(rand() * 1e10))));
      }
      const r = settle(state, orders, price, day, { feeBpsPerYear: 100, settlementsPerYear: 365 });
      paid += r.payouts.reduce((a, p) => a + p.luna, 0n);
      waiting = orders.filter((o) => r.results.find((x) => x.id === o.id)?.status === "waiting");
      state = poolStateFromJson(poolStateToJson(r.state));
      expect(deposited).toBe(paid + state.poolLuna + state.feeLuna);
      const t = poolTotals(state, price);
      const steadyOwed = Object.values(state.steady).reduce((a, v) => a + usdToLuna(v, price), 0n);
      expect(steadyOwed).toBeLessThanOrEqual(state.poolLuna);
      expect(t.claimLuna + t.boostLuna).toBe(state.poolLuna);
      expect(Object.values(state.boost).reduce((a, v) => a + v, 0n)).toBe(state.boostShares);
    }
  });
});

describe("amounts and storage", () => {
  it("parses and formats prices and dollars", () => {
    expect(parsePrice("0.0003016254871891327")).toBe(301_625_487n);
    expect(parsePrice(0.000278)).toBe(278_000_000n);
    expect(() => parsePrice("-1")).toThrow();
    expect(formatUsd(278_004_321n)).toBe("278.00");
    expect(parseUsd("$12.5")).toBe(12_500_000n);
    expect(parseUsd("12.345")).toBeNull();
  });

  it("round-trips the books through JSON", () => {
    const s = adaAndTunde().state;
    expect(poolStateFromJson(poolStateToJson(s))).toEqual(s);
  });
});

describe("the settlement price", () => {
  const src = (...ps: string[]) => ps.map((p, i) => ({ name: `s${i}`, price: parsePrice(p) }));
  it("takes the median of at least two sources that agree", () => {
    expect(choosePrice(src("0.0003016", "0.0002938", "0.000301"), 0n)).toEqual({ ok: true, price: parsePrice("0.000301") });
    expect(choosePrice(src("0.0003", "0.000302"), 0n)).toEqual({ ok: true, price: parsePrice("0.000301") });
  });
  it("pauses when sources are missing, disagree, or the price jumped", () => {
    expect(choosePrice(src("0.0003"), 0n)).toMatchObject({ ok: false, reason: expect.stringMatching(/at least 2/) });
    expect(choosePrice(src("0.0003", "0.00036"), 0n)).toMatchObject({ ok: false, reason: expect.stringMatching(/disagree/) });
    expect(choosePrice(src("0.0003", "0.000301"), parsePrice("0.00015"))).toMatchObject({ ok: false, reason: expect.stringMatching(/moved/) });
  });
});

describe("pool requests", () => {
  it("round-trips a signed withdrawal and refuses anything else", () => {
    const m = { address: ADA, side: "steady" as const, amount: "12.50", time: "2026-11-04T15:20:00.000Z", nonce: "9f2c4d1e8a7b6c5d" };
    expect(parsePoolWithdrawMessage(formatPoolWithdrawMessage(m))).toEqual({ ok: true, value: { ...m, amountUnits: 12_500_000n } });
    expect(parsePoolWithdrawMessage(formatPoolWithdrawMessage({ ...m, side: "boost", amount: "1000.5" }))).toMatchObject({ ok: true, value: { amountUnits: 100_050_000n } });
    expect(parsePoolWithdrawMessage(formatPoolWithdrawMessage({ ...m, amount: "all" }))).toMatchObject({ ok: true, value: { amountUnits: null } });
    for (const bad of [{ ...m, amount: "12.345" }, { ...m, amount: "0" }, { ...m, side: "both" as never }]) {
      expect(parsePoolWithdrawMessage(formatPoolWithdrawMessage(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(parsePoolWithdrawMessage(formatPoolWithdrawMessage(m) + "\n").ok).toBe(false);
  });
  it("writes and reads deposit memos", () => {
    expect(poolDepositMemo("steady", "7KQ2XMP9AB")).toBe("Errand Steady 7KQ2XMP9AB");
    expect(readPoolDepositMemo("Errand Boost 7KQ2XMP9AB")).toEqual({ side: "boost", orderId: "7KQ2XMP9AB" });
    expect(readPoolDepositMemo("Errand Boost 7KQ2XMP9AB extra")).toBeNull();
    expect(new TextEncoder().encode(poolDepositMemo("steady", "7KQ2XMP9AB")).length).toBeLessThanOrEqual(64);
  });
});

describe("ids and prices", () => {
  it("makes memo-safe order ids and prints prices back", async () => {
    const { newPoolOrderId, formatPrice, readPoolDepositMemo, poolDepositMemo } = await import("./pool");
    for (let i = 0; i < 50; i++) {
      const id = newPoolOrderId();
      expect(readPoolDepositMemo(poolDepositMemo("boost", id))).toEqual({ side: "boost", orderId: id });
    }
    expect(formatPrice(parsePrice("0.000301"))).toBe("0.000301");
    expect(formatPrice(parsePrice("2"))).toBe("2");
  });
});
