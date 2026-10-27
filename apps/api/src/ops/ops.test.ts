import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { issueSession, overLimit, parseInvites, verifySession, type BetaConfig } from "./beta";
import { betaMetrics } from "./metrics";
import { MemoryOpsStore, PgOpsStore, type OpsOrder, type OpsStore } from "./store";
import { watchOnce } from "./watcher";

const T = 1_800_000_000_000;
const CFG: BetaConfig = { invites: parseInvites("PAUL-7Q2=Paul, mama-k3=Paul's mum"), secret: "s3cret", maxSatsPerOrder: 150_000n, maxSatsPerDay: 300_000n };
const quote = (id: string, over: Partial<OpsOrder> = {}) => ({
  id, kind: "payout" as const, invite: "PAUL-7Q2", product: "ke-mpesa", receiveAmount: "2500", receiveCurrency: "KES",
  sats: "25000", createdAt: T, expiresAt: T + 5 * 60_000, ...over,
});

describe("beta sessions", () => {
  it("parses invites case-insensitively", () => {
    expect([...CFG.invites]).toEqual([["PAUL-7Q2", "Paul"], ["MAMA-K3", "Paul's mum"]]);
  });
  it("issues tokens that verify, and rejects tampering, expiry and removed invites", () => {
    const t = issueSession("PAUL-7Q2", CFG, T);
    expect(verifySession(t, CFG, T + 1000)).toBe("PAUL-7Q2");
    expect(verifySession(t.slice(0, -2) + "xx", CFG, T)).toBeNull();
    expect(verifySession(t, { ...CFG, secret: "other" }, T)).toBeNull();
    expect(verifySession(t, CFG, T + 31 * 86_400_000)).toBeNull();
    expect(verifySession(t, { ...CFG, invites: new Map() }, T)).toBeNull();
    expect(verifySession(undefined, CFG, T)).toBeNull();
  });
});

describe("beta limits", () => {
  it("caps one order and the rolling day", async () => {
    const store = new MemoryOpsStore();
    expect(await overLimit("PAUL-7Q2", 200_000n, CFG, store, T)).toMatch(/one payment can be up to 150,000 sats/);
    await store.recordQuote(quote("a", { sats: "140000" }));
    await store.setState("a", "done", T);
    await store.recordQuote(quote("b", { sats: "140000" }));
    expect(await overLimit("PAUL-7Q2", 30_000n, CFG, store, T)).toMatch(/24 hours/);
    expect(await overLimit("MAMA-K3", 30_000n, CFG, store, T)).toBeNull(); // another tester
  });
  it("doesn't count expired or failed quotes", async () => {
    const store = new MemoryOpsStore();
    await store.recordQuote(quote("a", { sats: "140000", expiresAt: T - 1 }));
    await store.recordQuote(quote("b", { sats: "140000" }));
    await store.setState("b", "failed", T);
    expect(await overLimit("PAUL-7Q2", 140_000n, CFG, store, T)).toBeNull();
  });
});

async function stores(): Promise<[string, OpsStore][]> {
  const { Pool } = newDb().adapters.createPg();
  const pg = new PgOpsStore(new Pool());
  await pg.migrate();
  return [["memory", new MemoryOpsStore()], ["postgres (pg-mem)", pg]];
}

describe("order log stores", async () => {
  for (const [name, store] of await stores()) {
    it(`${name}: records, updates, lists and keeps feedback`, async () => {
      await store.recordQuote(quote("o1"));
      await store.recordQuote(quote("o1", { sats: "1" })); // replay is ignored
      await store.setState("o1", "paid", T + 10);
      expect(await store.get("o1")).toMatchObject({ state: "paid", updatedAt: T + 10, sats: "25000", alertedAt: null });
      await store.markAlerted("o1", T + 20);
      expect((await store.get("o1"))?.alertedAt).toBe(T + 20);
      expect((await store.listSince(T)).map((o) => o.id)).toEqual(["o1"]);
      expect(await store.listSince(T + 1)).toEqual([]);
      await store.addFeedback({ id: "f1", invite: "PAUL-7Q2", orderId: "o1", message: "slow", createdAt: T });
      expect(await store.listFeedback(0)).toEqual([{ id: "f1", invite: "PAUL-7Q2", orderId: "o1", message: "slow", createdAt: T }]);
    });
  }
});

describe("watcher", () => {
  function setup(answers: Record<string, OpsOrder["state"]>) {
    const store = new MemoryOpsStore();
    const alerts: string[] = [];
    const refreshed: string[] = [];
    let now = T;
    const run = () =>
      watchOnce({
        store,
        now: () => now,
        alert: async (t) => void alerts.push(t),
        refresh: async (o) => (refreshed.push(o.id), answers[o.id] ?? null),
      });
    return { store, alerts, refreshed, run, advance: (ms: number) => (now += ms) };
  }

  it("catches a payment made after the app closed, then flags it when stuck", async () => {
    const h = setup({ a: "paid" });
    await h.store.recordQuote(quote("a"));
    await h.run();
    expect((await h.store.get("a"))?.state).toBe("paid");
    expect(h.alerts).toEqual([]);
    h.advance(31 * 60_000);
    await h.run();
    expect(h.alerts[0]).toMatch(/^STUCK: paid but not delivered after 31 min: payout a/);
    await h.run();
    expect(h.alerts).toHaveLength(1); // once per order
  });

  it("flags failures as possible refunds", async () => {
    const h = setup({ a: "failed" });
    await h.store.recordQuote(quote("a"));
    await h.run();
    expect(h.alerts[0]).toMatch(/^CHECK REFUND/);
  });

  it("quietly expires quotes nobody paid, and stops polling them", async () => {
    const h = setup({});
    await h.store.recordQuote(quote("a"));
    h.advance(21 * 60_000);
    await h.run();
    expect((await h.store.get("a"))?.state).toBe("expired");
    expect(h.alerts).toEqual([]);
    h.refreshed.length = 0;
    await h.run();
    expect(h.refreshed).toEqual([]);
  });

  it("stays inside a refresh budget", async () => {
    const h = setup({});
    for (let i = 0; i < 5; i++) await h.store.recordQuote(quote(`o${i}`));
    const r = await watchOnce({ store: h.store, now: () => T, alert: async () => {}, refresh: async () => null, maxRefreshes: 2 });
    expect(r.refreshed).toBe(2);
  });
});

describe("metrics", () => {
  it("counts payers, repeats, corridors and failures", () => {
    const o = (id: string, invite: string, state: OpsOrder["state"], product = "ke-mpesa"): OpsOrder =>
      ({ ...quote(id, { invite, product }), state, updatedAt: T, alertedAt: null });
    const m = betaMetrics([o("1", "A", "done"), o("2", "A", "done"), o("3", "B", "done", "ng-bank"), o("4", "B", "failed"), o("5", "C", "awaiting_payment")], T);
    expect(m).toMatchObject({
      weeklyActivePayers: 2, payersAllTime: 2, repeatPayers: 1, completedOrders: 3,
      completedByProduct: { "ke-mpesa": 2, "ng-bank": 1 }, failedOrders: 1, failedRate: 0.25,
    });
  });
});
