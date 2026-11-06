import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { formatPoolWithdrawMessage, nimiqAddressFromPublicKey, nimiqMessageHash, parsePrice, readPoolDepositMemo, type PoolWithdrawMessage } from "@railkit/core";
import { MemoryPoolStore, settleIfDue, type PoolConfig } from "@railkit/pool";
import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../app";

const T = Date.UTC(2026, 10, 4, 12, 5);
const POOL = "NQ26 0000 0000 02A5 YAK7 4QNF 9MH0 TE2B GVRU";
const P0 = parsePrice("0.000278");
const CFG: PoolConfig = {
  poolAddress: POOL, network: "testnet", settleEveryMinutes: 1440, settleAtMinuteUtc: 720, feeBpsPerYear: 0,
  caps: { maxSteadyUsdPerAddress: 300_000_000n }, minConfirmations: 60, depositTtlMs: 86_400_000,
};

function account() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from((publicKey as KeyObject).export({ format: "der", type: "spki" })).subarray(-32).toString("hex");
  return { address: nimiqAddressFromPublicKey(pub), publicKey: pub, sign: (m: string) => sign(null, nimiqMessageHash(m), privateKey).toString("hex") };
}

function setup() {
  const store = new MemoryPoolStore();
  const deps: AppDeps = {
    mavapay: { quote: async () => { throw new Error("unused"); }, getOrder: async () => { throw new Error("unused"); }, banks: async () => [], nameEnquiry: async () => ({ accountName: "" }) },
    corridors: new Set(),
    allowedOrigins: [],
    adminToken: "admin-secret",
    pool: { store, rpc: { balance: async () => 200_000_000_000n }, cfg: CFG },
    log: () => undefined,
    now: () => T,
  };
  return { app: createApp(deps), store };
}

const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const errorOf = async (r: Response) => ((await r.json()) as { error: { message: string } }).error.message;
let nonce = 0;
const withdrawal = (who: ReturnType<typeof account>, over: Partial<PoolWithdrawMessage> = {}) => {
  const message = formatPoolWithdrawMessage({ address: who.address, side: "steady", amount: "all", time: new Date(T).toISOString(), nonce: (++nonce).toString(16).padStart(16, "0"), ...over });
  return { message, publicKey: who.publicKey, signature: who.sign(message) };
};

/** Ada in Steady and Tunde in Boost, 1,000,000 NIM each, settled at $0.000278. */
async function funded() {
  const f = setup();
  const ada = account();
  const tunde = account();
  for (const [who, side] of [[tunde, "boost"], [ada, "steady"]] as const) {
    const { orderId } = await json(await f.app.request("/v1/pool/deposits", post({ address: who.address, side, nim: "1000000" })));
    await f.store.updateOrder(orderId, { status: "queued", luna: "100000000000", txHash: `${orderId}`.padEnd(64, "0"), queuedAt: T });
  }
  await settleIfDue({ store: f.store, prices: async () => [{ name: "a", price: P0 }, { name: "b", price: P0 }], cfg: CFG, now: T });
  return { ...f, ada, tunde };
}

describe("deposits", () => {
  it("creates an order with a memo Nimiq Pay shows and the watcher reads back", async () => {
    const { app } = setup();
    const r = await json(await app.request("/v1/pool/deposits", post({ address: POOL, side: "boost", nim: "500.5" })));
    expect(r).toMatchObject({ poolAddress: POOL, nim: "500.5", luna: "50050000", settlesAt: Date.UTC(2026, 10, 5, 12) });
    expect(readPoolDepositMemo(r.memo)).toEqual({ side: "boost", orderId: r.orderId });
  });

  it("refuses bad input, deposits over the cap, and anything while paused", async () => {
    const { app, ada } = await funded();
    for (const b of [{ address: "nope", side: "steady", nim: "1" }, { address: POOL, side: "both", nim: "1" }, { address: POOL, side: "steady", nim: "0.5" }, { address: POOL, side: "steady", nim: "1.123456" }]) {
      expect((await app.request("/v1/pool/deposits", post(b))).status, JSON.stringify(b)).toBe(400);
    }
    // Ada has $278 in Steady; the pilot's cap is $300.
    expect(await errorOf(await app.request("/v1/pool/deposits", post({ address: ada.address, side: "steady", nim: "100000" })))).toMatch(/limit of \$300\.00/);
    expect((await app.request("/v1/admin/pool/pause", post({ paused: true }, { Authorization: "Bearer admin-secret" }))).status).toBe(200);
    expect((await app.request("/v1/pool/deposits", post({ address: POOL, side: "boost", nim: "10" }))).status).toBe(503);
    expect((await app.request("/v1/admin/pool/pause", post({ paused: true }))).status).toBe(404);
  });
});

describe("withdrawals", () => {
  it("queue a signed withdrawal for the next settlement", async () => {
    const { app, ada, store } = await funded();
    const r = await json(await app.request("/v1/pool/withdrawals", post(withdrawal(ada, { amount: "100.50" }))));
    expect(r.settlesAt).toBe(Date.UTC(2026, 10, 5, 12));
    expect(await store.getOrder(r.orderId)).toMatchObject({ kind: "withdraw", side: "steady", amount: "100500000", status: "queued" });
  });

  it("refuse forged, foreign, replayed or empty withdrawals", async () => {
    const { app, ada, tunde } = await funded();
    const good = withdrawal(ada);
    expect((await app.request("/v1/pool/withdrawals", post({ ...good, signature: tunde.sign(good.message) }))).status).toBe(403);
    expect(await errorOf(await app.request("/v1/pool/withdrawals", post(withdrawal(tunde, { address: ada.address }))))).toMatch(/different Nimiq account/);
    expect((await app.request("/v1/pool/withdrawals", post(good))).status).toBe(200);
    expect(await errorOf(await app.request("/v1/pool/withdrawals", post(good)))).toMatch(/already used/);
    expect(await errorOf(await app.request("/v1/pool/withdrawals", post(withdrawal(ada, { side: "boost" }))))).toMatch(/anything in Boost/);
    expect(await errorOf(await app.request("/v1/pool/withdrawals", post(withdrawal(ada, { time: new Date(T - 11 * 60_000).toISOString() }))))).toMatch(/too old/);
  });
});

describe("reading the pool", () => {
  it("shows each side, the books and the reserves", async () => {
    const { app, ada, tunde } = await funded();
    expect((await json(await app.request(`/v1/pool/me?address=${encodeURIComponent(ada.address)}`))).steady).toEqual({ usd: "278.00", nimAtLastPrice: "1000000" });
    const t = await json(await app.request(`/v1/pool/me?address=${encodeURIComponent(tunde.address)}`));
    expect(t.boost).toEqual({ nim: "1000000", leveragePct: 200 });
    expect(t.orders[0]).toMatchObject({ kind: "deposit", side: "boost", status: "filled", nim: "1000000" });
    expect((await json(await app.request("/v1/pool/state"))).settlement).toEqual({ seq: 1, at: Date.UTC(2026, 10, 4, 12), priceUsd: "0.000278", coverBps: 10_000, steadyUsd: "278.00", boostNim: "1000000", boostLeveragePct: 200 });
    expect(await json(await app.request("/v1/pool/reserves"))).toMatchObject({ onChainNim: "2000000", owedNim: "2000000", covered: true, surplusNim: "0" });
  });
});
