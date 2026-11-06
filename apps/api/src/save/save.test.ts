import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  formatSaveMessage,
  nimiqAddressBytes,
  nimiqAddressFromPublicKey,
  nimiqMessageHash,
  STAKING_CONTRACT,
  type NimiqTransaction,
  type NimiqValidator,
  type SaveRuleMessage,
  type StakerState,
} from "@railkit/core";
import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../app";
import { MemorySaveStore, PgSaveStore, type SaveStore } from "./store";

const T = 1_793_800_000_000;
const NIM = (n: number) => BigInt(n) * 100_000n;
const VALIDATOR = "NQ26 0000 0000 02A5 YAK7 4QNF 9MH0 TE2B GVRU";
const APP_PAYOUT = "NQ49 N8MB XYCR XBUP 404C KXKK L49M A7BT F082";

/** A Nimiq account as Nimiq Pay holds it: an Ed25519 key, its address, and sign() as Nimiq Pay does it. */
function account() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from((publicKey as KeyObject).export({ format: "der", type: "spki" })).subarray(-32).toString("hex");
  const address = nimiqAddressFromPublicKey(pub);
  return { address, publicKey: pub, sign: (message: string) => sign(null, nimiqMessageHash(message), privateKey).toString("hex") };
}

let nonce = 0;
const rule = (address: string, over: Partial<SaveRuleMessage> = {}): SaveRuleMessage => ({
  action: "set", address, savePercent: 30, time: new Date(T).toISOString(), nonce: (++nonce).toString(16).padStart(16, "0"), ...over,
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
    transactionsByAddress: async (a: string) => [...txs.values()].filter((t) => t.from === a || t.to === a),
    blockNumber: async () => 65_966_500,
  };
  return { stakers, validators, txs, chain };
}

function setup(over: {
  store?: SaveStore;
  recommended?: { address: string; name: string }[];
  phraser?: (q: string, english: string) => Promise<string>;
  classifier?: (text: string) => Promise<{ question: "code" | "balance" } | null>;
} = {}) {
  const f = fakeChain();
  const store = over.store ?? new MemorySaveStore();
  const clock = { t: T };
  /** Opens Grow for an address: 500 NIM staked with VALIDATOR unless told otherwise. */
  const stake = (address: string, s: Partial<StakerState> = {}) =>
    f.stakers.set(address, { active: NIM(500), inactive: 0n, inactiveFrom: null, retired: 0n, delegation: VALIDATOR, ...s });
  const deps: AppDeps = {
    mavapay: { quote: async () => { throw new Error("unused"); }, getOrder: async () => { throw new Error("unused"); }, banks: async () => [], nameEnquiry: async () => ({ accountName: "" }) },
    corridors: new Set(),
    allowedOrigins: ["https://errand.example"],
    adminToken: "admin-secret",
    save: { store, chain: f.chain, network: "mainnet", recommended: over.recommended },
    agent: { savingsPhraser: over.phraser, savingsClassifier: over.classifier },
    log: () => undefined,
    now: () => clock.t,
  };
  return { app: createApp(deps), ...f, store, clock, stake };
}

const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const signed = (who: ReturnType<typeof account>, m: SaveRuleMessage) => {
  const message = formatSaveMessage(m);
  return { message, publicKey: who.publicKey, signature: who.sign(message) };
};
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const errorOf = async (r: Response) => ((await r.json()) as { error: { message: string } }).error.message;

async function withApp(app: ReturnType<typeof setup>["app"]) {
  const r = await app.request("/v1/admin/save/apps", post({ name: "Arcade", payoutAddresses: [APP_PAYOUT] }, { Authorization: "Bearer admin-secret" }));
  const { apiKey } = await json(r);
  return { Authorization: `Bearer ${apiKey as string}` };
}

describe("setting the rule", () => {
  it("creates a code from a rule signed in Nimiq Pay, and keeps the same code when the rule changes", async () => {
    const { app, stake } = setup();
    const amaka = account();
    stake(amaka.address);
    const r = await app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address))));
    expect(r.status).toBe(200);
    const first = await json(r);
    expect(first).toMatchObject({ address: amaka.address, savePercent: 30 });
    expect(first.code).toMatch(/^SAVE-[0-9A-HJKMNP-TV-Z]{7}$/);
    const again = await json(await app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address, { savePercent: 50 })))));
    expect(again).toEqual({ code: first.code, address: amaka.address, savePercent: 50 });
  });

  it("won't give out a code before Grow is open, but an existing code keeps working if Grow closes later", async () => {
    const { app, stake, stakers } = setup();
    const amaka = account();
    const refused = await app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address))));
    expect(refused.status).toBe(403);
    expect(await errorOf(refused)).toMatch(/Open Grow first/);
    // A stake that's all on its way out doesn't count as open either.
    stake(amaka.address, { active: 0n, retired: NIM(500) });
    expect((await app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address))))).status).toBe(403);
    stake(amaka.address);
    const { code } = await json(await app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address)))));
    stakers.delete(amaka.address);
    expect(await json(await app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address, { savePercent: 10 })))))).toEqual({ code, address: amaka.address, savePercent: 10 });
  });

  it("refuses a forged, foreign, stale, replayed or malformed request", async () => {
    const { app, stake } = setup();
    const amaka = account();
    const mallory = account();
    stake(amaka.address);
    const m = rule(amaka.address);
    const good = signed(amaka, m);
    expect((await app.request("/v1/save/rule", post({ ...good, signature: mallory.sign(good.message) }))).status).toBe(403);
    // Mallory signs a rule for Amaka's address with her own key.
    const foreign = await app.request("/v1/save/rule", post({ ...signed(mallory, rule(amaka.address)) }));
    expect(foreign.status).toBe(403);
    expect(await errorOf(foreign)).toMatch(/different Nimiq account/);
    expect(await errorOf(await app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address, { time: new Date(T - 11 * 60_000).toISOString() })))))).toMatch(/too old/);
    expect((await app.request("/v1/save/rule", post(good))).status).toBe(200);
    expect(await errorOf(await app.request("/v1/save/rule", post(good)))).toMatch(/already used/);
    expect((await app.request("/v1/save/rule", post({ ...good, message: good.message + " " }))).status).toBe(400);
    expect((await app.request("/v1/save/rule", post({ message: good.message }))).status).toBe(400);
  });

  it("revokes the code, after which apps can't use it", async () => {
    const { app, stake } = setup();
    const headers = await withApp(app);
    const amaka = account();
    stake(amaka.address);
    const { code } = await json(await app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address)))));
    expect(await json(await app.request("/v1/save/rule", post(signed(amaka, { ...rule(amaka.address), action: "revoke", savePercent: undefined }))))).toEqual({ revoked: true });
    expect((await app.request(`/v1/save/split?code=${code as string}&luna=100000`, { headers })).status).toBe(404);
  });
});

describe("splitting a payout (for apps)", () => {
  it("needs a known app key", async () => {
    const { app } = setup();
    expect((await app.request("/v1/save/split?code=SAVE-0000000&luna=1")).status).toBe(401);
    expect((await app.request("/v1/save/split?code=SAVE-0000000&luna=1", { headers: { Authorization: `Bearer rk_save_${"0".repeat(64)}` } })).status).toBe(401);
    expect((await app.request("/v1/admin/save/apps", post({ name: "X", payoutAddresses: [APP_PAYOUT] }))).status).toBe(404);
  });

  it("splits into wallet and Grow when the user stakes, and falls back to the wallet when Grow can't take it", async () => {
    const amaka = account();
    /** Gets a code with Grow open, changes the chain, then asks for the split. */
    async function splitWith(change: (f: ReturnType<typeof setup>) => void, luna: bigint) {
      const f = setup();
      f.stake(amaka.address);
      const headers = await withApp(f.app);
      const { code } = await json(await f.app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address)))));
      change(f);
      // Past the stake and validator caches (1 and 10 minutes).
      f.clock.t += 11 * 60_000;
      return json(await f.app.request(`/v1/save/split?code=${code as string}&luna=${luna}`, { headers }));
    }

    expect(await splitWith(() => undefined, NIM(2000))).toMatchObject({
      address: amaka.address, savePercent: 30, wallet: { luna: NIM(1400).toString() }, grow: { luna: NIM(600).toString(), staker: amaka.address }, reason: null,
    });
    expect(await splitWith((f) => f.stakers.delete(amaka.address), NIM(2000))).toMatchObject({ wallet: { luna: NIM(2000).toString() }, grow: null, reason: "no-stake" });
    expect(await splitWith((f) => f.validators.clear(), NIM(2000))).toMatchObject({ grow: null, reason: "validator-gone" });
    expect(await splitWith((f) => f.stake(amaka.address, { active: 0n, retired: NIM(500) }), NIM(10))).toMatchObject({ grow: null, reason: "below-minimum" });
  });

  it("refuses bad input", async () => {
    const { app } = setup();
    const headers = await withApp(app);
    for (const q of ["code=nope&luna=1", "code=SAVE-0000000&luna=0", "code=SAVE-0000000&luna=1.5", "code=SAVE-0000000&luna=-3"]) {
      expect((await app.request(`/v1/save/split?${q}`, { headers })).status, q).toBe(400);
    }
  });
});

describe("receipts (for apps)", () => {
  it("records transactions that check out on-chain, and says pending for ones not in a block yet", async () => {
    const { app, txs, stake } = setup();
    const headers = await withApp(app);
    const amaka = account();
    stake(amaka.address);
    const { code } = await json(await app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address)))));
    const stakerHex = Buffer.from(nimiqAddressBytes(amaka.address)).toString("hex");
    const tx = (hash: string, over: Partial<NimiqTransaction>): NimiqTransaction => ({
      hash, blockNumber: 65_966_400, from: APP_PAYOUT, to: amaka.address, value: NIM(1400), recipientData: "", senderData: "", executionResult: true, confirmations: 3, timestamp: T, ...over,
    });
    txs.set("a".repeat(64), tx("a".repeat(64), {}));
    txs.set("b".repeat(64), tx("b".repeat(64), { to: STAKING_CONTRACT, value: NIM(600), recipientData: `06${stakerHex}` }));

    const r = await app.request("/v1/save/receipts", post({ code, payoutId: "bounty-81", walletTx: "a".repeat(64), growTx: "b".repeat(64) }, headers));
    expect(await json(r)).toEqual({ walletTx: "recorded", growTx: "recorded" });
    expect(await json(await app.request("/v1/save/receipts", post({ code, payoutId: "bounty-82", growTx: "c".repeat(64) }, headers)))).toEqual({ growTx: "pending" });

    const me = await json(await app.request(`/v1/save/me?address=${encodeURIComponent(amaka.address)}`));
    expect(me.receipts).toEqual([
      expect.objectContaining({ app: "Arcade", kind: "wallet", luna: NIM(1400).toString() }),
      expect.objectContaining({ app: "Arcade", kind: "grow", luna: NIM(600).toString() }),
    ]);
  });

  it("refuses transactions from elsewhere, to the wrong place, or that failed", async () => {
    const { app, txs, stake } = setup();
    const headers = await withApp(app);
    const amaka = account();
    stake(amaka.address);
    const other = account();
    const { code } = await json(await app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address)))));
    const otherHex = Buffer.from(nimiqAddressBytes(other.address)).toString("hex");
    const base = { blockNumber: 1, value: NIM(1), executionResult: true, confirmations: 1, recipientData: "", senderData: "", timestamp: T };
    txs.set("1".repeat(64), { hash: "1".repeat(64), from: other.address, to: amaka.address, ...base });
    txs.set("2".repeat(64), { hash: "2".repeat(64), from: APP_PAYOUT, to: other.address, ...base });
    txs.set("3".repeat(64), { hash: "3".repeat(64), from: APP_PAYOUT, to: STAKING_CONTRACT, ...base, recipientData: `06${otherHex}` });
    txs.set("4".repeat(64), { hash: "4".repeat(64), from: APP_PAYOUT, to: amaka.address, ...base, executionResult: false });
    const send = (b: Record<string, string>) => app.request("/v1/save/receipts", post({ code, payoutId: "p1", ...b }, headers));
    expect((await send({ walletTx: "1".repeat(64) })).status).toBe(403);
    expect(await errorOf(await send({ walletTx: "2".repeat(64) }))).toMatch(/didn't pay this code's address/);
    expect(await errorOf(await send({ growTx: "3".repeat(64) }))).toMatch(/isn't an add-stake/);
    expect(await errorOf(await send({ walletTx: "4".repeat(64) }))).toMatch(/failed on-chain/);
    expect((await send({ walletTx: "xyz" })).status).toBe(400);
  });
});

describe("questions about your own savings", () => {
  async function ready() {
    const f = setup({ phraser: async (_q, english) => english.replace("Your save code is", "Nambari yako ya kuokoa ni") });
    const headers = await withApp(f.app);
    const amaka = account();
    f.stake(amaka.address);
    const { code } = await json(await f.app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address)))));
    const ask = (question: string, extra: Record<string, unknown> = {}) => f.app.request("/v1/save/ask", post({ address: amaka.address, question, ...extra }));
    return { ...f, headers, amaka, code: code as string, ask };
  }

  it("answers from the user's own data", async () => {
    const { ask, code } = await ready();
    expect(await json(await ask("how much have I saved?"))).toEqual({ answer: "You have 500 NIM in Grow, all of it earning staking rewards.", question: "balance", source: "rules" });
    expect((await json(await ask("what's my save code"))).answer).toBe(`Your save code is ${code}. Apps pay 30% of what they send you into Grow.`);
    expect((await json(await ask("when can I get my money?"))).answer).toMatch(/haven't started a withdrawal/);
  });

  it("explains why a payout went to the wallet, when the app said which payout it was", async () => {
    const { app, ask, headers, code, stakers, amaka, clock } = await ready();
    stakers.delete(amaka.address);
    clock.t += 2 * 60_000; // past the stake cache
    const split = await json(await app.request(`/v1/save/split?code=${code}&luna=${NIM(2000)}&payoutId=bounty-81`, { headers }));
    expect(split.reason).toBe("no-stake");
    expect((await json(await ask("why did that payment go to my wallet?"))).answer).toBe(`Your 2,000 NIM from Arcade on ${new Date(clock.t).getUTCDate()} Nov all went to your wallet because Grow wasn't open.`);
    const me = await json(await app.request(`/v1/save/me?address=${encodeURIComponent(amaka.address)}`));
    expect(me.splits).toEqual([expect.objectContaining({ payoutId: "bounty-81", app: "Arcade", walletLuna: NIM(2000).toString(), growLuna: "0", reason: "no-stake" })]);
    expect((await app.request(`/v1/save/split?code=${code}&luna=1&payoutId=has spaces`, { headers })).status).toBe(400);
  });

  it("refuses things that aren't questions about savings", async () => {
    const { ask } = await ready();
    for (const q of ["Put 500 NIM in Grow", "send 2000 KES to Mary", ""]) expect((await ask(q)).status, q).toBe(400);
    expect((await json(await ask("how much did I save this month?", { tzOffsetMinutes: 99_999 }))).question).toBe("period");
  });

  it("answers a question in another language, reworded only when the facts survive", async () => {
    const swahili = "Nambari yangu ya kuokoa ni ipi?";
    const classifier = async () => ({ question: "code" as const });
    const f = setup({ classifier, phraser: async (_q, english) => english.replace("Your save code is", "Nambari yako ya kuokoa ni") });
    const amaka = account();
    f.stake(amaka.address);
    const { code } = await json(await f.app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address)))));
    const r = await json(await f.app.request("/v1/save/ask", post({ address: amaka.address, question: swahili })));
    expect(r).toEqual({ answer: `Nambari yako ya kuokoa ni ${code}. Apps pay 30% of what they send you into Grow.`, question: "code", source: "model" });
    // The chat already knows the kind: no second classification.
    const noClassifier = setup({ phraser: async (_q, english) => english });
    noClassifier.stake(amaka.address);
    await noClassifier.app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address))));
    expect((await json(await noClassifier.app.request("/v1/save/ask", post({ address: amaka.address, question: swahili, kind: "balance" })))).question).toBe("balance");
    expect((await noClassifier.app.request("/v1/save/ask", post({ address: amaka.address, question: swahili }))).status).toBe(400);

    const liar = setup({ classifier, phraser: async () => "Nambari yako ni SAVE-0000000, 90%." });
    liar.stake(amaka.address);
    await liar.app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address))));
    const l = await json(await liar.app.request("/v1/save/ask", post({ address: amaka.address, question: swahili })));
    expect(l.source).toBe("rules");
    expect(l.answer).toMatch(/^Your save code is SAVE-/);
  });
});

describe("the savings screen", () => {
  it("shows the code, Grow from the chain, and when inactive stake is released", async () => {
    const { app, stake } = setup();
    const amaka = account();
    stake(amaka.address);
    const { code } = await json(await app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address)))));
    stake(amaka.address, { active: NIM(300), inactive: NIM(200), inactiveFrom: 65_966_400 });
    const me = await json(await app.request(`/v1/save/me?address=${encodeURIComponent(amaka.address)}&fresh=1`));
    expect(me).toMatchObject({
      network: "mainnet", code, savePercent: 30, blockNumber: 65_966_500, growClosed: null,
      grow: { active: NIM(300).toString(), inactive: NIM(200).toString(), inactiveFrom: 65_966_400, retired: "0", delegation: VALIDATOR, releaseBlock: 65_966_400 + 43_201, validatorJailed: false },
    });
    const nobody = await json(await app.request(`/v1/save/me?address=${encodeURIComponent(account().address)}`));
    expect(nobody).toMatchObject({ code: null, grow: null, growClosed: "no-stake", receipts: [] });
    expect((await app.request("/v1/save/me?address=NQ00")).status).toBe(400);
  });

  it("lists validators, recommended ones first, without jailed or retired ones", async () => {
    const { app, validators } = setup({ recommended: [{ address: "NQ16 085S 7JNP YJNY UA5N G5Y5 B98N 0JT7 6GKB", name: "Pool A" }] });
    validators.set("NQ16 085S 7JNP YJNY UA5N G5Y5 B98N 0JT7 6GKB", { address: "NQ16 085S 7JNP YJNY UA5N G5Y5 B98N 0JT7 6GKB", balance: NIM(10), numStakers: 1, jailedFrom: null, retired: false });
    validators.set("NQ61 1RMT GEPQ VA7A XDY3 NGQM 8ESG KR6B GH8M", { address: "NQ61 1RMT GEPQ VA7A XDY3 NGQM 8ESG KR6B GH8M", balance: NIM(5), numStakers: 1, jailedFrom: 100, retired: false });
    const { validators: list } = await json(await app.request("/v1/save/validators"));
    expect(list.map((v: { address: string; name: string | null }) => [v.address, v.name])).toEqual([
      ["NQ16 085S 7JNP YJNY UA5N G5Y5 B98N 0JT7 6GKB", "Pool A"],
      [VALIDATOR, null],
    ]);
  });
});

describe("savings activity", () => {
  it("lists each payment in with its wallet and Grow parts, and the person's own Grow transactions, newest first", async () => {
    const { app, store, txs, stake } = setup();
    const amaka = account();
    stake(amaka.address);
    const { code } = await json(await app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address)))));
    await store.addApp({ id: "arcade", name: "Arcade", keyHash: "k", payoutAddresses: [APP_PAYOUT], createdAt: T });
    const receipt = (txHash: string, kind: "wallet" | "grow", luna: bigint, payoutId: string, at: number) =>
      store.addReceipt({ txHash, code, address: amaka.address, appId: "arcade", kind, luna: luna.toString(), payoutId, blockNumber: 1, createdAt: at });
    await receipt("a".repeat(64), "wallet", NIM(1400), "bounty-81", T);
    await receipt("b".repeat(64), "grow", NIM(600), "bounty-81", T);
    await receipt("c".repeat(64), "wallet", NIM(1000), "bounty-82", T + 60_000);
    await store.addSplit({ appId: "arcade", payoutId: "bounty-82", code, address: amaka.address, walletLuna: NIM(1000).toString(), growLuna: "0", reason: "below-minimum", savePercent: 30, createdAt: T + 60_000 });
    const mine = { from: amaka.address, to: STAKING_CONTRACT, blockNumber: 1, senderData: "", executionResult: true, confirmations: 1 };
    txs.set("d".repeat(64), { ...mine, hash: "d".repeat(64), value: NIM(500), recipientData: `05${Buffer.from(nimiqAddressBytes(VALIDATOR)).toString("hex")}`, timestamp: T - 1_000 });
    txs.set("e".repeat(64), { ...mine, hash: "e".repeat(64), value: 0n, recipientData: "08", timestamp: T + 120_000 });

    const r = await json(await app.request(`/v1/save/activity?address=${encodeURIComponent(amaka.address)}`));
    expect(r.payments).toEqual([
      { payoutId: "bounty-82", app: "Arcade", walletLuna: NIM(1000).toString(), growLuna: "0", at: T + 60_000, reason: "below-minimum" },
      { payoutId: "bounty-81", app: "Arcade", walletLuna: NIM(1400).toString(), growLuna: NIM(600).toString(), at: T, reason: null },
    ]);
    expect(r.grow).toEqual([
      { txHash: "e".repeat(64), kind: "withdrawal-started", luna: "0", at: T + 120_000, ok: true },
      { txHash: "d".repeat(64), kind: "opened", luna: NIM(500).toString(), at: T - 1_000, ok: true },
    ]);
  });

  it("still lists payments when the chain can't be read, and says so", async () => {
    const { app, chain } = setup();
    chain.transactionsByAddress = async () => {
      throw new Error("node down");
    };
    expect(await json(await app.request(`/v1/save/activity?address=${encodeURIComponent(account().address)}`))).toEqual({ payments: [], grow: null });
    expect((await app.request("/v1/save/activity?address=NQ00")).status).toBe(400);
  });
});

async function stores(): Promise<[string, SaveStore][]> {
  const { Pool } = newDb().adapters.createPg();
  const pg = new PgSaveStore(new Pool());
  await pg.migrate();
  return [["memory", new MemorySaveStore()], ["postgres (pg-mem)", pg]];
}

describe("save stores", async () => {
  for (const [name, store] of await stores()) {
    it(`${name}: codes, nonces, apps and receipts`, async () => {
      expect(await store.insertCode({ code: "AAAAAAA", address: "NQ1", savePercent: 30, createdAt: T, updatedAt: T, revokedAt: null })).toBe(true);
      expect(await store.insertCode({ code: "AAAAAAA", address: "NQ2", savePercent: 10, createdAt: T, updatedAt: T, revokedAt: null })).toBe(false);
      await store.updatePercent("AAAAAAA", 40, T + 1);
      expect(await store.activeCodeByAddress("NQ1")).toMatchObject({ code: "AAAAAAA", savePercent: 40, updatedAt: T + 1 });
      await store.revoke("AAAAAAA", T + 2);
      expect(await store.activeCode("AAAAAAA")).toBeUndefined();
      expect(await store.activeCodeByAddress("NQ1")).toBeUndefined();

      expect(await store.useNonce("n1", T)).toBe(true);
      expect(await store.useNonce("n1", T + 1)).toBe(false);
      expect(await store.useNonce("n1", T + 86_400_001)).toBe(true); // forgotten after a day

      await store.addApp({ id: "app1", name: "Arcade", keyHash: "h1", payoutAddresses: ["NQ9", "NQ8"], createdAt: T });
      expect(await store.appByKeyHash("h1")).toMatchObject({ id: "app1", payoutAddresses: ["NQ9", "NQ8"] });
      expect(await store.listApps()).toHaveLength(1);

      const r = { txHash: "t1", code: "AAAAAAA", address: "NQ1", appId: "app1", kind: "grow" as const, luna: "600", payoutId: "p", blockNumber: 5, createdAt: T };
      await store.addReceipt(r);
      await store.addReceipt({ ...r, luna: "999" }); // replay is ignored
      expect(await store.receiptsForAddress("NQ1", 10)).toEqual([r]);

      const sp = { appId: "app1", payoutId: "p1", code: "AAAAAAA", address: "NQ1", walletLuna: "2000", growLuna: "0", reason: "no-stake" as const, savePercent: 30, createdAt: T };
      await store.addSplit(sp);
      await store.addSplit({ ...sp, growLuna: "600", reason: null }); // a retried payout keeps the first split
      await store.addSplit({ ...sp, appId: "app2", reason: null, createdAt: T + 1 });
      expect(await store.splitsForAddress("NQ1", 10)).toEqual([{ ...sp, appId: "app2", reason: null, createdAt: T + 1 }, sp]);
    });
  }
});
