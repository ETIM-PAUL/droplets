import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { formatDrawMessage, nimiqAddressBytes, nimiqAddressFromPublicKey, nimiqMessageHash, pickWinner, prizeWeek, STAKING_CONTRACT, type NimiqTransaction } from "@railkit/core";
import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../app";
import { checkStakes, firstBlockAtOrAfter, runDraw, type PrizeDeps } from "./routes";
import { MemoryPrizeStore, PgPrizeStore, type PrizeStore } from "./store";

const NIM = (n: number) => BigInt(n) * 100_000n;
// The week of Monday 9 November 2026, West Africa Time; the draw is Sunday 15 November at 23:59.
const WEEK = prizeWeek("2026-11-09", 60)!;
const at = (day: number, hour: number) => WEEK.days[day]!.start + hour * 3_600_000;
const PRIZE_WALLET = "NQ49 N8MB XYCR XBUP 404C KXKK L49M A7BT F082";
const VALIDATOR = "NQ26 0000 0000 02A5 YAK7 4QNF 9MH0 TE2B GVRU";
const PHONE = "d".repeat(64);
const hashOf = (n: number) => n.toString(16).padStart(64, "0");
const hexOf = (a: string) => Array.from(nimiqAddressBytes(a), (b) => b.toString(16).padStart(2, "0")).join("");

/** A Nimiq account as Nimiq Pay holds it: an Ed25519 key, its address, and sign() as Nimiq Pay does it. */
function account() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from((publicKey as KeyObject).export({ format: "der", type: "spki" })).subarray(-32).toString("hex");
  return { address: nimiqAddressFromPublicKey(pub), publicKey: pub, sign: (message: string) => sign(null, nimiqMessageHash(message), privateKey).toString("hex") };
}

/** A transaction from someone to the staking contract, as the node reports it. */
const stakingTx = (from: string, recipientData: string, timestamp: number, value = 0n): NimiqTransaction => ({
  hash: randomBytes(32).toString("hex"), blockNumber: 1, from, to: STAKING_CONTRACT, value, recipientData, senderData: "", executionResult: true, confirmations: 10, timestamp,
});
const setActive = (from: string, luna: bigint, timestamp: number) => stakingTx(from, `08${luna.toString(16).padStart(16, "0")}${"ab".repeat(80)}`, timestamp);

/** A node with blocks one second apart up to `tip`, stakes, histories and transactions by hash. */
function fakeChain() {
  const stakes = new Map<string, bigint>();
  const history = new Map<string, NimiqTransaction[]>();
  const onChain = new Map<string, NimiqTransaction>();
  const tip = { number: 5_000_000, timestamp: at(0, 0) };
  let down = false;
  const chain: PrizeDeps["chain"] = {
    staker: async (a) => {
      if (down) throw new Error("node down");
      const v = stakes.get(a);
      return v === undefined ? null : { active: v, inactive: 0n, inactiveFrom: null, retired: 0n, delegation: VALIDATOR };
    },
    transactionsByAddress: async (a) => history.get(a) ?? [],
    latestBlock: async () => ({ number: tip.number, hash: hashOf(tip.number), timestamp: tip.timestamp }),
    block: async (n) => ({ number: n, hash: hashOf(n), timestamp: tip.timestamp - (tip.number - n) * 1_000 }),
    transaction: async (h) => onChain.get(h) ?? null,
  };
  return { chain, stakes, history, onChain, tip, setDown: (v: boolean) => void (down = v) };
}

function setup(store: PrizeStore = new MemoryPrizeStore()) {
  const f = fakeChain();
  const clock = { t: at(0, 10) };
  const prize: PrizeDeps = { store, chain: f.chain, rules: { minLuna: NIM(1_000), daysNeeded: 5, prizeLuna: NIM(1_000), utcOffsetMinutes: 60 }, prizeAddress: PRIZE_WALLET };
  const deps: AppDeps = { corridors: new Set(), allowedOrigins: [], adminToken: "admin-secret", prize, log: () => undefined, now: () => clock.t };
  /** Moves the clock and the chain's tip together. */
  const setTime = (t: number) => {
    f.tip.number += Math.round((t - f.tip.timestamp) / 1_000);
    f.tip.timestamp = t;
    clock.t = t;
  };
  return { app: createApp(deps), prize, store, clock, setTime, ...f };
}

const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const ADMIN = { Authorization: "Bearer admin-secret" };
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const errorOf = async (r: Response) => ((await r.json()) as { error: { message: string } }).error.message;
const signedJoin = (who: ReturnType<typeof account>, time: number, action: "join" | "leave" = "join", device = PHONE) => {
  const message = formatDrawMessage({ action, address: who.address, time: new Date(time).toISOString(), nonce: randomBytes(8).toString("hex") });
  return { message, publicKey: who.publicKey, signature: who.sign(message), device };
};
const noLog = () => undefined;

describe("joining the weekly draw", () => {
  it("joins with a signed message and the phone's identifier, and reads the stake right away", async () => {
    const { app, store, stakes, clock } = setup();
    const ada = account();
    stakes.set(ada.address, NIM(2_000));
    const r = await app.request("/v1/prize/join", post(signedJoin(ada, clock.t)));
    expect(await json(r)).toEqual({ joined: true });
    expect(await store.entry(ada.address)).toMatchObject({ device: PHONE, joinedAt: clock.t });
    expect(await store.checks(ada.address, 0)).toEqual([{ address: ada.address, at: clock.t, activeLuna: NIM(2_000).toString() }]);
  });

  it("allows one account per phone, and lets an account move to a new phone", async () => {
    const { app, clock } = setup();
    const [ada, ben] = [account(), account()];
    expect((await app.request("/v1/prize/join", post(signedJoin(ada, clock.t)))).status).toBe(200);
    const taken = await app.request("/v1/prize/join", post(signedJoin(ben, clock.t)));
    expect(taken.status).toBe(409);
    expect(await errorOf(taken)).toMatch(/already in the draw with another account/);
    expect((await app.request("/v1/prize/join", post(signedJoin(ada, clock.t, "join", "e".repeat(64))))).status).toBe(200);
    expect((await app.request("/v1/prize/join", post(signedJoin(ben, clock.t)))).status).toBe(200);
  });

  it("refuses another account's signature, a reused request, and a missing phone identifier", async () => {
    const { app, clock } = setup();
    const [ada, ben] = [account(), account()];
    const body = signedJoin(ada, clock.t);
    expect((await app.request("/v1/prize/join", post({ ...body, publicKey: ben.publicKey }))).status).toBe(403);
    expect((await app.request("/v1/prize/join", post(body))).status).toBe(200);
    expect(await errorOf(await app.request("/v1/prize/join", post(body)))).toMatch(/already used/);
    expect(await errorOf(await app.request("/v1/prize/join", post(signedJoin(ben, clock.t, "join", ""))))).toMatch(/recognise this phone/);
  });

  it("leaves with a signed message", async () => {
    const { app, store, clock } = setup();
    const ada = account();
    await app.request("/v1/prize/join", post(signedJoin(ada, clock.t)));
    expect(await json(await app.request("/v1/prize/join", post(signedJoin(ada, clock.t, "leave"))))).toEqual({ joined: false });
    expect(await store.entry(ada.address)).toBeUndefined();
  });
});

describe("this week, for one person", () => {
  it("marks each day kept or missed from the chain, with today so far and the days ahead", async () => {
    const { app, store, stakes, history, setTime } = setup();
    const ada = account();
    await store.join({ address: ada.address, device: PHONE, joinedAt: at(0, 1), checkedAt: null });
    await store.addCheck({ address: ada.address, at: at(0, 1), activeLuna: NIM(2_000).toString() });
    // Tuesday: a withdrawal takes Grow to 500 NIM for the afternoon, then it's topped up again.
    history.set(ada.address, [setActive(ada.address, NIM(500), at(1, 12)), stakingTx(ada.address, `06${hexOf(ada.address)}`, at(1, 18), NIM(1_500))]);
    stakes.set(ada.address, NIM(2_000));
    setTime(at(3, 10)); // Thursday morning
    const me = await json(await app.request(`/v1/prize/me?address=${encodeURIComponent(ada.address)}`));
    expect(me.joined).toBe(true);
    expect(me.week.days.map((d: { status: string }) => d.status)).toEqual(["kept", "missed", "kept", "today", "ahead", "ahead", "ahead"]);
    expect(me.week).toMatchObject({ week: "2026-11-09", drawAt: WEEK.drawAt, daysKept: 3, tickets: 0 });
    expect(me.rules).toMatchObject({ minLuna: NIM(1_000).toString(), daysNeeded: 5, prizeLuna: NIM(1_000).toString(), maxTickets: 4, prizeAddress: PRIZE_WALLET });
  });

  it("says so when the person hasn't joined", async () => {
    const { app } = setup();
    const me = await json(await app.request(`/v1/prize/me?address=${encodeURIComponent(account().address)}`));
    expect(me).toMatchObject({ joined: false, week: null, lastDraw: null, wins: [] });
  });
});

describe("reading stakes", () => {
  it("reads entries that are due, and records nothing when the node can't be reached", async () => {
    const { prize, store, stakes, setDown } = setup();
    const ada = account();
    await store.join({ address: ada.address, device: PHONE, joinedAt: at(0, 1), checkedAt: null });
    stakes.set(ada.address, NIM(3_000));
    setDown(true);
    expect(await checkStakes(prize, at(0, 2), noLog)).toBe(0);
    expect(await store.checks(ada.address, 0)).toEqual([]);
    setDown(false);
    expect(await checkStakes(prize, at(0, 3), noLog)).toBe(1);
    // Read just now: not due again for six hours.
    expect(await checkStakes(prize, at(0, 4), noLog)).toBe(0);
    expect(await store.checks(ada.address, 0)).toEqual([{ address: ada.address, at: at(0, 3), activeLuna: NIM(3_000).toString() }]);
  });
});

describe("the Sunday draw", () => {
  it("finds the first block made at or after a moment", async () => {
    const { chain, tip } = fakeChain();
    tip.timestamp = WEEK.drawAt + 300_500;
    const b = await firstBlockAtOrAfter(chain, WEEK.drawAt);
    expect(b).toMatchObject({ number: tip.number - 300, timestamp: WEEK.drawAt + 500 });
  });

  it("scores everyone who joined before the draw from the chain, and lets the block's hash pick the ticket", async () => {
    const s = setup();
    const [ada, ben, cy, dee] = [account(), account(), account(), account()];
    const keep = async (who: ReturnType<typeof account>, nim: number, joinedAt = at(0, 0)) => {
      await s.store.join({ address: who.address, device: randomBytes(32).toString("hex"), joinedAt, checkedAt: null });
      await s.store.addCheck({ address: who.address, at: joinedAt + 1, activeLuna: NIM(nim).toString() });
    };
    await keep(ada, 5_000); // all week: 1 ticket
    await keep(ben, 20_000); // all week, more: 2 tickets
    await keep(cy, 50_000); // took it all out on Wednesday: only 2 days
    s.history.set(cy.address, [setActive(cy.address, 0n, at(2, 9))]);
    await keep(dee, 50_000, WEEK.drawAt + 1); // joined after the draw time

    s.setTime(WEEK.drawAt + 60_000);
    expect(await runDraw(s.prize, s.clock.t, noLog)).toBeNull(); // the deciding block hasn't settled yet
    s.setTime(WEEK.drawAt + 3 * 60_000);
    const d = (await runDraw(s.prize, s.clock.t, noLog))!;
    const block = await firstBlockAtOrAfter(s.chain, WEEK.drawAt);
    const expected = pickWinner([{ address: ada.address, tickets: 1 }, { address: ben.address, tickets: 2 }], block!.hash)!;
    expect(d).toMatchObject({ week: "2026-11-09", blockNumber: block!.number, totalTickets: 3, winner: expected.address, winningTicket: expected.ticket, status: "unpaid" });
    expect(d.entries.map((e) => [e.address, e.tickets]).sort()).toEqual([[ada.address, 1], [ben.address, 2]].sort());
    expect(await runDraw(s.prize, s.clock.t + 60_000, noLog)).toBeNull(); // once per week
  });

  it("records a week where nobody qualified", async () => {
    const s = setup();
    s.setTime(WEEK.drawAt + 3 * 60_000);
    expect(await runDraw(s.prize, s.clock.t, noLog)).toMatchObject({ status: "no-entries", winner: null, totalTickets: 0 });
  });

  it("skips an account whose history is too long to reach back to the week's start", async () => {
    const s = setup();
    const ada = account();
    await s.store.join({ address: ada.address, device: PHONE, joinedAt: at(0, 0), checkedAt: null });
    await s.store.addCheck({ address: ada.address, at: at(0, 0) + 1, activeLuna: NIM(5_000).toString() });
    s.history.set(ada.address, Array.from({ length: 500 }, (_, i) => ({ ...stakingTx(ada.address, "", at(5, 1) + i), to: VALIDATOR })));
    s.setTime(WEEK.drawAt + 3 * 60_000);
    expect(await runDraw(s.prize, s.clock.t, noLog)).toMatchObject({ status: "no-entries" });
  });
});

describe("paying the prize", () => {
  async function drawn() {
    const s = setup();
    const ada = account();
    await s.store.join({ address: ada.address, device: PHONE, joinedAt: at(0, 0), checkedAt: null });
    await s.store.addCheck({ address: ada.address, at: at(0, 0) + 1, activeLuna: NIM(5_000).toString() });
    s.setTime(WEEK.drawAt + 3 * 60_000);
    await runDraw(s.prize, s.clock.t, noLog);
    return { ...s, ada };
  }

  it("lists unpaid draws for the payout tool, and keeps what it signed", async () => {
    const { app, ada } = await drawn();
    expect((await app.request("/v1/admin/prize/unpaid")).status).toBe(404);
    const unpaid = await json(await app.request("/v1/admin/prize/unpaid", { headers: ADMIN }));
    expect(unpaid).toEqual({ prizeAddress: PRIZE_WALLET, draws: [{ week: "2026-11-09", winner: ada.address, prizeLuna: NIM(1_000).toString(), payout: null }] });
    expect((await app.request("/v1/admin/prize/payout", post({ week: "2026-11-09", payout: "{\"txs\":[]}" }, ADMIN))).status).toBe(200);
    expect((await json(await app.request("/v1/admin/prize/unpaid", { headers: ADMIN }))).draws[0].payout).toBe("{\"txs\":[]}");
  });

  it("counts the prize paid only once the chain shows it, from the prize wallet, into the winner's Grow", async () => {
    const { app, ada, onChain } = await drawn();
    const paid = (txHash: string) => app.request("/v1/admin/prize/paid", post({ week: "2026-11-09", txHash }, ADMIN));
    const intoGrow = { ...stakingTx(PRIZE_WALLET, `06${hexOf(ada.address)}`, WEEK.drawAt + 600_000, NIM(1_000)), hash: "a".repeat(64) };
    expect(await json(await paid(intoGrow.hash))).toEqual({ status: "pending" });
    onChain.set("b".repeat(64), { ...intoGrow, hash: "b".repeat(64), from: VALIDATOR });
    expect((await paid("b".repeat(64))).status).toBe(403);
    onChain.set(intoGrow.hash, intoGrow);
    expect(await json(await paid(intoGrow.hash))).toEqual({ status: "paid", txHash: intoGrow.hash });
    const me = await json(await app.request(`/v1/prize/me?address=${encodeURIComponent(ada.address)}`));
    expect(me.wins).toEqual([{ week: "2026-11-09", drawAt: WEEK.drawAt, prizeLuna: NIM(1_000).toString(), paid: true, payoutTx: intoGrow.hash }]);
    expect(me.lastDraw).toMatchObject({ youWon: true, paid: true, winner: `${ada.address.slice(0, 4)} … ${ada.address.slice(-4)}` });
  });
});

async function stores(): Promise<[string, PrizeStore][]> {
  const { Pool } = newDb().adapters.createPg();
  const pg = new PgPrizeStore(new Pool());
  await pg.migrate();
  return [["memory", new MemoryPrizeStore()], ["postgres (pg-mem)", pg]];
}

describe("prize stores", async () => {
  for (const [name, store] of await stores()) {
    it(`${name}: entries, readings and draws`, async () => {
      expect(await store.useNonce("n1", 1)).toBe(true);
      expect(await store.useNonce("n1", 2)).toBe(false);
      await store.join({ address: "NQ1", device: "p1", joinedAt: 10, checkedAt: null });
      await store.join({ address: "NQ2", device: "p2", joinedAt: 20, checkedAt: null });
      expect(await store.entryByDevice("p2")).toMatchObject({ address: "NQ2" });
      await store.addCheck({ address: "NQ1", at: 100, activeLuna: "5" });
      await store.addCheck({ address: "NQ1", at: 200, activeLuna: "6" });
      await store.addCheck({ address: "NQ1", at: 300, activeLuna: "7" });
      expect((await store.checks("NQ1", 250)).map((c) => c.at)).toEqual([200, 300]);
      expect((await store.due(250, 10)).map((e) => e.address)).toEqual(["NQ2"]);
      await store.leave("NQ2");
      expect((await store.entries()).map((e) => e.address)).toEqual(["NQ1"]);
      await store.pruneChecks(250);
      expect((await store.checks("NQ1", 0)).map((c) => c.at)).toEqual([300]);

      const row = {
        week: "2026-11-09", drawAt: 1_000, blockNumber: 7, blockHash: "ab".repeat(32), entries: [{ address: "NQ1", tickets: 1, daysKept: 6, keptLuna: "5" }],
        totalTickets: 1, winningTicket: 0, winner: "NQ1", prizeLuna: "100", status: "unpaid" as const, payout: null, payoutTx: null, paidAt: null, createdAt: 1_001,
      };
      expect(await store.addDraw(row)).toBe(true);
      expect(await store.addDraw(row)).toBe(false);
      await store.setPayout("2026-11-09", "{}");
      expect(await store.unpaid()).toEqual([{ ...row, payout: "{}" }]);
      await store.markPaid("2026-11-09", "cd".repeat(32), 2_000);
      expect(await store.wins("NQ1")).toEqual([{ ...row, payout: "{}", status: "paid", payoutTx: "cd".repeat(32), paidAt: 2_000 }]);
      expect(await store.unpaid()).toEqual([]);
    });
  }
});
