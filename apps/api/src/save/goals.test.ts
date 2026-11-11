import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  BREAK_FEE_ADDRESS,
  breakFeeLuna,
  formatGoalMessage,
  nimiqAddressFromPublicKey,
  nimiqMessageHash,
  type GoalMessage,
  type NimiqTransaction,
  type NimiqValidator,
  type StakerState,
} from "@railkit/core";
import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../app";
import { MemoryGoalStore, PgGoalStore, type GoalStore } from "./goals-store";
import { MemorySaveStore } from "./store";

const T = Date.UTC(2026, 10, 10, 9); // Tuesday 10 November 2026, 09:00 UTC
const NIM = (n: number) => BigInt(n) * 100_000n;
const VALIDATOR = "NQ26 0000 0000 02A5 YAK7 4QNF 9MH0 TE2B GVRU";
const DAY = 86_400_000;

function account() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from((publicKey as KeyObject).export({ format: "der", type: "spki" })).subarray(-32).toString("hex");
  const address = nimiqAddressFromPublicKey(pub);
  return { address, publicKey: pub, sign: (message: string) => sign(null, nimiqMessageHash(message), privateKey).toString("hex") };
}

let nonce = 0;
const goalMsg = (address: string, over: Partial<GoalMessage> = {}): GoalMessage => ({
  action: "create", address, time: new Date(T).toISOString(), nonce: (++nonce).toString(16).padStart(16, "0"), ...over,
});

function fakeChain() {
  const stakers = new Map<string, StakerState>();
  const validators = new Map<string, NimiqValidator>([[VALIDATOR, { address: VALIDATOR, balance: NIM(1_000_000), numStakers: 9, jailedFrom: null, retired: false }]]);
  const txs = new Map<string, NimiqTransaction>();
  const chain = {
    staker: async (a: string) => stakers.get(a) ?? null,
    validator: async (a: string) => validators.get(a) ?? null,
    activeValidators: async () => [...validators.values()],
    transaction: async (h: string) => txs.get(h) ?? null,
    transactionsByAddress: async () => [],
    blockNumber: async () => 65_966_500,
  };
  return { stakers, txs, chain };
}

/** Records a fee payment to Droplets' break-fee address, as if it just confirmed on-chain. */
const feeTx = (txs: Map<string, NimiqTransaction>, hash: string, from: string, value: bigint, over: Partial<NimiqTransaction> = {}) =>
  txs.set(hash, { hash, blockNumber: 1, from, to: BREAK_FEE_ADDRESS, value, recipientData: "", senderData: "", executionResult: true, confirmations: 1, timestamp: T, ...over });

function setup(over: { goals?: GoalStore } = {}) {
  const f = fakeChain();
  const clock = { t: T };
  const stake = (address: string, s: Partial<StakerState> = {}) => f.stakers.set(address, { active: NIM(500), inactive: 0n, inactiveFrom: null, retired: 0n, delegation: VALIDATOR, ...s });
  const deps: AppDeps = {
    corridors: new Set(),
    allowedOrigins: ["https://droplets.example"],
    save: { store: new MemorySaveStore(), goals: over.goals, chain: f.chain, network: "mainnet" },
    log: () => undefined,
    now: () => clock.t,
  };
  return { app: createApp(deps), ...f, clock, stake };
}

const post = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const signed = (who: ReturnType<typeof account>, m: GoalMessage) => {
  const message = formatGoalMessage(m);
  return { message, publicKey: who.publicKey, signature: who.sign(message) };
};
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const errorOf = async (r: Response) => ((await r.json()) as { error: { message: string } }).error.message;

describe("creating, editing, reordering, deleting and breaking a goal", () => {
  it("creates a goal from a signed message, with and without a target or a date", async () => {
    const { app } = setup();
    const ada = account();
    const r = await app.request("/v1/save/goals", post(signed(ada, goalMsg(ada.address, { name: "School fees", targetLuna: NIM(50_000), dueAt: Date.UTC(2027, 2, 1) }))));
    expect(r.status).toBe(200);
    const { id } = await json(r);
    expect(typeof id).toBe("string");
    const list = await json(await app.request(`/v1/save/goals?address=${encodeURIComponent(ada.address)}`));
    expect(list.goals).toEqual([
      expect.objectContaining({ id, name: "School fees", targetLuna: NIM(50_000).toString(), dueAt: Date.UTC(2027, 2, 1), allocatedLuna: "0", done: false, locked: true, breaking: false, breached: false }),
    ]);
  });

  it("refuses a forged, foreign, stale, replayed or malformed request", async () => {
    const { app } = setup();
    const ada = account();
    const mallory = account();
    const m = goalMsg(ada.address, { name: "Trip", targetLuna: null, dueAt: null });
    const good = signed(ada, m);
    expect((await app.request("/v1/save/goals", post({ ...good, signature: mallory.sign(good.message) }))).status).toBe(403);
    const foreign = await app.request("/v1/save/goals", post(signed(mallory, goalMsg(ada.address, { name: "Trip", targetLuna: null, dueAt: null }))));
    expect(foreign.status).toBe(403);
    expect(await errorOf(foreign)).toMatch(/different Nimiq account/);
    expect((await app.request("/v1/save/goals", post(good))).status).toBe(200);
    expect(await errorOf(await app.request("/v1/save/goals", post(good)))).toMatch(/already used/);
    expect((await app.request("/v1/save/goals", post({ ...good, message: good.message + " " }))).status).toBe(400);
  });

  it("edits a goal's name, target and date", async () => {
    const { app } = setup();
    const ada = account();
    const { id } = await json(await app.request("/v1/save/goals", post(signed(ada, goalMsg(ada.address, { name: "Trip", targetLuna: NIM(1_000), dueAt: null })))));
    await app.request("/v1/save/goals", post(signed(ada, goalMsg(ada.address, { action: "edit", goalId: id, name: "Trip to Lagos", targetLuna: NIM(2_000), dueAt: Date.UTC(2027, 0, 1) }))));
    const list = await json(await app.request(`/v1/save/goals?address=${encodeURIComponent(ada.address)}`));
    expect(list.goals[0]).toMatchObject({ name: "Trip to Lagos", targetLuna: NIM(2_000).toString(), dueAt: Date.UTC(2027, 0, 1) });
    expect(await errorOf(await app.request("/v1/save/goals", post(signed(ada, goalMsg(ada.address, { action: "edit", goalId: "nope", name: "X", targetLuna: null, dueAt: null })))))).toMatch(/No goal/);
  });

  it("reorders only when the list matches exactly, and deletes a goal", async () => {
    const { app } = setup();
    const ada = account();
    const a = (await json(await app.request("/v1/save/goals", post(signed(ada, goalMsg(ada.address, { name: "A", targetLuna: null, dueAt: null })))))).id;
    const b = (await json(await app.request("/v1/save/goals", post(signed(ada, goalMsg(ada.address, { name: "B", targetLuna: null, dueAt: null })))))).id;
    expect((await app.request("/v1/save/goals", post(signed(ada, goalMsg(ada.address, { action: "reorder", order: [a] }))))).status).toBe(400);
    expect((await app.request("/v1/save/goals", post(signed(ada, goalMsg(ada.address, { action: "reorder", order: [b, a] }))))).status).toBe(200);
    let list = await json(await app.request(`/v1/save/goals?address=${encodeURIComponent(ada.address)}`));
    expect(list.goals.map((g: { id: string }) => g.id)).toEqual([b, a]);
    expect((await app.request("/v1/save/goals", post(signed(ada, goalMsg(ada.address, { action: "delete", goalId: b }))))).status).toBe(200);
    list = await json(await app.request(`/v1/save/goals?address=${encodeURIComponent(ada.address)}`));
    expect(list.goals.map((g: { id: string }) => g.id)).toEqual([a]);
  });

  it("caps goals per address", async () => {
    const { app, clock } = setup();
    const ada = account();
    for (let i = 0; i < 20; i++) {
      // Past the rule rate limit (20 a minute), so the cap itself is what the 21st request hits.
      if (i > 0 && i % 20 === 0) clock.t += 61_000;
      const r = await app.request("/v1/save/goals", post(signed(ada, goalMsg(ada.address, { name: `Goal ${i}`, targetLuna: null, dueAt: null }))));
      expect(r.status, `goal ${i}`).toBe(200);
    }
    clock.t += 61_000;
    const over = await app.request("/v1/save/goals", post(signed(ada, goalMsg(ada.address, { name: "One too many", targetLuna: null, dueAt: null }))));
    expect(over.status).toBe(400);
    expect(await errorOf(over)).toMatch(/up to 20 goals/);
  });
});

describe("filling goals as savings grow, and what's locked", () => {
  it("doesn't fill retroactively: the first read just remembers where the stake stood", async () => {
    const { app, stake } = setup();
    const ada = account();
    stake(ada.address, { active: NIM(500) });
    await app.request("/v1/save/goals", post(signed(ada, goalMsg(ada.address, { name: "A", targetLuna: NIM(100), dueAt: null }))));
    const list = await json(await app.request(`/v1/save/goals?address=${encodeURIComponent(ada.address)}&fresh=1`));
    expect(list.goals[0]).toMatchObject({ allocatedLuna: "0" });
    expect(list.totalLuna).toBe(NIM(500).toString());
  });

  it("fills the first goal to its target, then the next, as the stake grows across reads", async () => {
    const { app, stake } = setup();
    const ada = account();
    stake(ada.address, { active: NIM(500) });
    await app.request("/v1/save/goals", post(signed(ada, goalMsg(ada.address, { name: "A", targetLuna: NIM(100), dueAt: null }))));
    const bId = (await json(await app.request("/v1/save/goals", post(signed(ada, goalMsg(ada.address, { name: "B", targetLuna: null, dueAt: null })))))).id;
    await json(await app.request(`/v1/save/goals?address=${encodeURIComponent(ada.address)}&fresh=1`)); // sets the cursor at 500
    stake(ada.address, { active: NIM(650) }); // 150 NIM grew
    const list = await json(await app.request(`/v1/save/goals?address=${encodeURIComponent(ada.address)}&fresh=1`));
    const byName = (name: string) => list.goals.find((g: { name: string; id: string }) => g.name === name || g.id === name);
    expect(byName("A").allocatedLuna).toBe(NIM(100).toString());
    expect(byName(bId).allocatedLuna).toBe(NIM(50).toString());
  });

  it("locks a dated goal, excludes it from withdrawable, and unlocks it once broken (after its fee is paid) and the cooldown passes", async () => {
    const { app, stake, clock, txs } = setup();
    const ada = account();
    stake(ada.address, { active: NIM(1_000) });
    await json(await app.request(`/v1/save/goals?address=${encodeURIComponent(ada.address)}&fresh=1`)); // cursor at 1,000
    const id = (await json(await app.request("/v1/save/goals", post(signed(ada, goalMsg(ada.address, { name: "Trip", targetLuna: null, dueAt: T + 10 * DAY })))))).id;
    stake(ada.address, { active: NIM(1_400) }); // 400 NIM grows into the open-ended, now-locked goal
    let list = await json(await app.request(`/v1/save/goals?address=${encodeURIComponent(ada.address)}&fresh=1`));
    expect(list.goals[0]).toMatchObject({ allocatedLuna: NIM(400).toString(), locked: true });
    expect(list.withdrawableLuna).toBe(NIM(1_000).toString());

    const fee = breakFeeLuna(NIM(400));
    const hash = "f".repeat(64);
    feeTx(txs, hash, ada.address, fee);
    const breakReq = await app.request("/v1/save/goals", post({ ...signed(ada, goalMsg(ada.address, { action: "break", goalId: id })), feeTx: hash }));
    expect((await json(breakReq)).feeLuna).toBe(fee.toString());
    list = await json(await app.request(`/v1/save/goals?address=${encodeURIComponent(ada.address)}`));
    expect(list.goals[0]).toMatchObject({ locked: true, breaking: true });
    expect(list.withdrawableLuna).toBe(NIM(1_000).toString()); // still locked during the cooling-off

    clock.t += 24 * 3_600_000; // the cooldown passes
    list = await json(await app.request(`/v1/save/goals?address=${encodeURIComponent(ada.address)}`));
    expect(list.goals[0]).toMatchObject({ locked: false, breaking: false });
    expect(list.withdrawableLuna).toBe(NIM(1_400).toString());
  });

  it("refuses to break a goal without its fee, charges the right amount, and lets the request be retried while the fee tx is still pending", async () => {
    const { app, stake, txs } = setup();
    const ada = account();
    stake(ada.address, { active: NIM(1_000) });
    await json(await app.request(`/v1/save/goals?address=${encodeURIComponent(ada.address)}&fresh=1`));
    const id = (await json(await app.request("/v1/save/goals", post(signed(ada, goalMsg(ada.address, { name: "Trip", targetLuna: null, dueAt: T + 10 * DAY })))))).id;
    stake(ada.address, { active: NIM(1_500) }); // 500 NIM grows into the goal; breaking it costs 10% = 50 NIM
    await json(await app.request(`/v1/save/goals?address=${encodeURIComponent(ada.address)}&fresh=1`));

    const noFee = await app.request("/v1/save/goals", post(signed(ada, goalMsg(ada.address, { action: "break", goalId: id }))));
    expect(noFee.status).toBe(400); // no feeTx at all

    const underpaid = "a".repeat(64);
    feeTx(txs, underpaid, ada.address, NIM(10)); // far short of the 50 NIM owed
    const short = await app.request("/v1/save/goals", post({ ...signed(ada, goalMsg(ada.address, { action: "break", goalId: id })), feeTx: underpaid }));
    expect(short.status).toBe(403);

    // The fee tx hasn't landed yet: the same signed message comes back pending, and its nonce isn't burned.
    const pendingHash = "b".repeat(64);
    const retryMsg = signed(ada, goalMsg(ada.address, { action: "break", goalId: id }));
    const pending = await app.request("/v1/save/goals", post({ ...retryMsg, feeTx: pendingHash }));
    expect(await json(pending)).toEqual({ pending: true });

    // Once the fee tx is visible on-chain, retrying that exact signed message (same nonce) succeeds.
    feeTx(txs, pendingHash, ada.address, NIM(50));
    const ok = await app.request("/v1/save/goals", post({ ...retryMsg, feeTx: pendingHash }));
    expect(ok.status).toBe(200);
    expect((await json(ok)).feeLuna).toBe(NIM(50).toString());
  });

  it("flags a locked goal as breached only when a withdrawal made outside Droplets reaches into it", async () => {
    const { app, stake } = setup();
    const ada = account();
    stake(ada.address, { active: NIM(1_000) });
    await json(await app.request(`/v1/save/goals?address=${encodeURIComponent(ada.address)}&fresh=1`)); // cursor at 1,000
    await app.request("/v1/save/goals", post(signed(ada, goalMsg(ada.address, { name: "Trip", targetLuna: null, dueAt: Date.UTC(2027, 0, 1) }))));
    stake(ada.address, { active: NIM(1_400) }); // 400 grows into the locked goal
    await json(await app.request(`/v1/save/goals?address=${encodeURIComponent(ada.address)}&fresh=1`));
    // Withdrawn to 200 directly in Nimiq Pay, bypassing Droplets's own withdraw screen: eats into the locked goal.
    stake(ada.address, { active: NIM(200) });
    const list = await json(await app.request(`/v1/save/goals?address=${encodeURIComponent(ada.address)}&fresh=1`));
    expect(list.goals[0]).toMatchObject({ allocatedLuna: "0", breached: true, locked: false });
    expect(list.bannedUntil).toBe(T + 30 * DAY);
    // Creating a new goal is refused while banned, even with a perfectly good signed message.
    const create = await app.request("/v1/save/goals", post(signed(ada, goalMsg(ada.address, { name: "New one", targetLuna: null, dueAt: null }))));
    expect(create.status).toBe(403);
  });

  it("never treats a stale cached read as a withdrawal: a non-fresh poll right after a deposit must not falsely breach a locked goal", async () => {
    const { app, stake } = setup();
    const ada = account();
    stake(ada.address, { active: NIM(1_000) });
    await json(await app.request(`/v1/save/goals?address=${encodeURIComponent(ada.address)}&fresh=1`)); // cursor at 1,000
    await app.request("/v1/save/goals", post(signed(ada, goalMsg(ada.address, { name: "Trip", targetLuna: null, dueAt: Date.UTC(2027, 0, 1) }))));
    // A non-fresh read right now caches the pre-deposit total for 60 seconds.
    await json(await app.request(`/v1/save/goals?address=${encodeURIComponent(ada.address)}`));
    stake(ada.address, { active: NIM(1_400) }); // 400 NIM lands, e.g. opening Grow or a third-party app's payout
    await json(await app.request(`/v1/save/goals?address=${encodeURIComponent(ada.address)}&fresh=1`)); // fresh: cursor advances to 1,400, fills the goal
    // A routine non-fresh poll, still inside that cache window, would otherwise serve the stale 1,000 and
    // read as a 400 NIM withdrawal reaching into the locked goal.
    const list = await json(await app.request(`/v1/save/goals?address=${encodeURIComponent(ada.address)}`));
    expect(list.goals[0]).toMatchObject({ allocatedLuna: NIM(400).toString(), breached: false, locked: true });
    expect(list.bannedUntil).toBeNull();
  });

  it("sends a declared top-up to the named goal first, then waterfalls anything else over the rest", async () => {
    const { app, stake } = setup();
    const ada = account();
    stake(ada.address, { active: NIM(1_000) });
    await json(await app.request(`/v1/save/goals?address=${encodeURIComponent(ada.address)}&fresh=1`));
    const first = (await json(await app.request("/v1/save/goals", post(signed(ada, goalMsg(ada.address, { name: "First", targetLuna: NIM(100), dueAt: null })))))).id;
    const second = (await json(await app.request("/v1/save/goals", post(signed(ada, goalMsg(ada.address, { name: "Second", targetLuna: NIM(50), dueAt: null })))))).id;
    stake(ada.address, { active: NIM(1_080) }); // added 80, meant for "Second"
    const list = await json(await app.request(`/v1/save/goals?address=${encodeURIComponent(ada.address)}&fresh=1&creditGoal=${second}&creditLuna=${NIM(80)}`));
    const byId = (id: string) => list.goals.find((g: { id: string }) => g.id === id);
    expect(byId(second).allocatedLuna).toBe(NIM(50).toString()); // capped by its own target
    expect(byId(first).allocatedLuna).toBe(NIM(30).toString()); // the rest waterfalls to the next goal in order
  });
});

describe("goal stores", async () => {
  async function stores(): Promise<[string, GoalStore][]> {
    const { Pool } = newDb().adapters.createPg();
    const pg = new PgGoalStore(new Pool());
    await pg.migrate();
    return [["memory", new MemoryGoalStore()], ["postgres (pg-mem)", pg]];
  }
  for (const [name, store] of await stores()) {
    it(`${name}: create, edit, reorder, delete, break and the cursor`, async () => {
      const fresh = { id: "g1", address: "NQ1", name: "A", targetLuna: null, dueAt: null, allocatedLuna: "0", breakRequestedAt: null, breachedAt: null, createdAt: T, updatedAt: T };
      expect(await store.insertGoal(fresh)).toBe(true);
      expect(await store.insertGoal({ ...fresh, id: "g2", name: "B" })).toBe(true);
      const mine = await store.listGoals("NQ1");
      expect(mine.map((g) => g.id)).toEqual(["g1", "g2"]);
      expect(mine[0]!.order).toBe(0);
      expect(mine[1]!.order).toBe(1);

      expect(await store.updateGoal("NQ1", "g1", { name: "A2", targetLuna: "500", dueAt: T }, T + 1)).toBe(true);
      expect(await store.updateGoal("NQ1", "nope", { name: "X" }, T + 1)).toBe(false);
      expect(await store.getGoal("NQ1", "g1")).toMatchObject({ name: "A2", targetLuna: "500", dueAt: T });

      expect(await store.reorderGoals("NQ1", ["g1"], T + 2)).toBe(false); // doesn't name every goal
      expect(await store.reorderGoals("NQ1", ["g2", "g1"], T + 2)).toBe(true);
      expect((await store.listGoals("NQ1")).map((g) => g.id)).toEqual(["g2", "g1"]);

      expect(await store.requestBreak("NQ1", "g1", T + 3)).toBe(true);
      expect(await store.requestBreak("NQ1", "g1", T + 4)).toBe(true); // keeps the first timestamp
      expect((await store.getGoal("NQ1", "g1"))!.breakRequestedAt).toBe(T + 3);

      await store.applyGoalChanges(new Map([["g1", 700n]]), new Set(["g1"]), T + 5);
      const g1 = await store.getGoal("NQ1", "g1");
      expect(g1!.allocatedLuna).toBe("700");
      expect(g1!.breachedAt).toBe(T + 5);

      expect(await store.deleteGoal("NQ1", "g2")).toBe(true);
      expect(await store.deleteGoal("NQ1", "g2")).toBe(false);
      expect((await store.listGoals("NQ1")).map((g) => g.id)).toEqual(["g1"]);

      expect(await store.goalCursor("NQ1")).toBeUndefined();
      await store.setGoalCursor("NQ1", 1_000n, T);
      expect(await store.goalCursor("NQ1")).toBe(1_000n);
      await store.setGoalCursor("NQ1", 1_500n, T + 1);
      expect(await store.goalCursor("NQ1")).toBe(1_500n);
    });

    it(`${name}: caps at 20 goals per address`, async () => {
      for (let i = 0; i < 20; i++) {
        expect(await store.insertGoal({ id: `h${i}`, address: "NQ2", name: `G${i}`, targetLuna: null, dueAt: null, allocatedLuna: "0", breakRequestedAt: null, breachedAt: null, createdAt: T, updatedAt: T })).toBe(true);
      }
      expect(await store.insertGoal({ id: "h20", address: "NQ2", name: "One too many", targetLuna: null, dueAt: null, allocatedLuna: "0", breakRequestedAt: null, breachedAt: null, createdAt: T, updatedAt: T })).toBe(false);
    });
  }
});
