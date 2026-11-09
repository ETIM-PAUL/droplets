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
    expect(again).toEqual({ code: first.code, address: amaka.address, savePercent: 50, spendPercent: 0, appIds: [], catchUp: "weekly" });
  });

  it("won't give out a code before Grow is open, but an existing code keeps working if Grow closes later", async () => {
    const { app, stake, stakers } = setup();
    const amaka = account();
    const refused = await app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address))));
    expect(refused.status).toBe(403);
    expect(await errorOf(refused)).toMatch(/Open your savings first/);
    // A stake that's all on its way out doesn't count as open either.
    stake(amaka.address, { active: 0n, retired: NIM(500) });
    expect((await app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address))))).status).toBe(403);
    stake(amaka.address);
    const { code } = await json(await app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address)))));
    stakers.delete(amaka.address);
    expect(await json(await app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address, { savePercent: 10 })))))).toEqual({ code, address: amaka.address, savePercent: 10, spendPercent: 0, appIds: [], catchUp: "weekly" });
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
    expect(await errorOf(await send({ walletTx: "2".repeat(64) }))).toMatch(/didn't pay this saver's address/);
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
    expect(await json(await ask("how much have I saved?"))).toEqual({ answer: "You have 500 NIM in savings, all of it earning staking rewards.", question: "balance", source: "rules" });
    expect((await json(await ask("what's my save code"))).answer).toBe(`Your save code is ${code}. Apps pay 30% of what they send you into savings.`);
    expect((await json(await ask("when can I get my money?"))).answer).toMatch(/haven't started a withdrawal/);
  });

  it("explains why a payout went to the wallet, when the app said which payout it was", async () => {
    const { app, ask, headers, code, stakers, amaka, clock } = await ready();
    stakers.delete(amaka.address);
    clock.t += 2 * 60_000; // past the stake cache
    const split = await json(await app.request(`/v1/save/split?code=${code}&luna=${NIM(2000)}&payoutId=bounty-81`, { headers }));
    expect(split.reason).toBe("no-stake");
    expect((await json(await ask("why did that payment go to my wallet?"))).answer).toBe(`Your 2,000 NIM from Arcade on ${new Date(clock.t).getUTCDate()} Nov all went to your wallet because your savings weren't open.`);
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
    expect(r).toEqual({ answer: `Nambari yako ya kuokoa ni ${code}. Apps pay 30% of what they send you into savings.`, question: "code", source: "model" });
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
      store.addReceipt({ txHash, code, address: amaka.address, appId: "arcade", kind, source: "payout", luna: luna.toString(), payoutId, blockNumber: 1, createdAt: at });
    await receipt("a".repeat(64), "wallet", NIM(1400), "bounty-81", T);
    await receipt("b".repeat(64), "grow", NIM(600), "bounty-81", T);
    await receipt("c".repeat(64), "wallet", NIM(1000), "bounty-82", T + 60_000);
    await store.addSplit({ appId: "arcade", payoutId: "bounty-82", code, address: amaka.address, walletLuna: NIM(1000).toString(), growLuna: "0", reason: "below-minimum", savePercent: 30, createdAt: T + 60_000 });
    const mine = { from: amaka.address, to: STAKING_CONTRACT, blockNumber: 1, senderData: "", executionResult: true, confirmations: 1 };
    txs.set("d".repeat(64), { ...mine, hash: "d".repeat(64), value: NIM(500), recipientData: `05${Buffer.from(nimiqAddressBytes(VALIDATOR)).toString("hex")}`, timestamp: T - 1_000 });
    txs.set("e".repeat(64), { ...mine, hash: "e".repeat(64), value: 0n, recipientData: "08", timestamp: T + 120_000 });

    const r = await json(await app.request(`/v1/save/activity?address=${encodeURIComponent(amaka.address)}`));
    expect(r.payments).toEqual([
      { payoutId: "bounty-82", app: "Arcade", source: "payout", walletLuna: NIM(1000).toString(), growLuna: "0", at: T + 60_000, reason: "below-minimum" },
      { payoutId: "bounty-81", app: "Arcade", source: "payout", walletLuna: NIM(1400).toString(), growLuna: NIM(600).toString(), at: T, reason: null },
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

describe("apps that recognise your address (for apps)", () => {
  /** Arcade and Quiz Night are registered; Amaka stakes and allows only Arcade, saving 30% of payouts and 5% when she pays. */
  async function ready() {
    const f = setup();
    const arcade = await withApp(f.app);
    const quiz = { Authorization: `Bearer ${(await json(await f.app.request("/v1/admin/save/apps", post({ name: "Quiz Night", payoutAddresses: [APP_PAYOUT] }, { Authorization: "Bearer admin-secret" })))).apiKey as string}` };
    const amaka = account();
    f.stake(amaka.address);
    const r = await json(await f.app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address, { spendPercent: 5, apps: ["Arcade"], catchUp: "weekly" })))));
    const at = (who: Record<string, string>, path: string) => f.app.request(path, { headers: who });
    return { ...f, arcade, quiz, amaka, code: r.code as string, at, a: encodeURIComponent(amaka.address) };
  }

  it("splits by address for an app the user allowed, without giving out the code", async () => {
    const { at, arcade, amaka, a } = await ready();
    expect(await json(await at(arcade, `/v1/save/split?address=${a}&luna=${NIM(2000)}`))).toEqual({
      code: null, address: amaka.address, savePercent: 30, wallet: { luna: NIM(1400).toString() }, grow: { luna: NIM(600).toString(), staker: amaka.address }, reason: null,
    });
  });

  it("answers the same for an app the user didn't allow as for someone who doesn't save with Errand", async () => {
    const { at, arcade, quiz, a } = await ready();
    const stranger = encodeURIComponent(account().address);
    const plain = (address: string) => ({ code: null, address: decodeURIComponent(address), savePercent: 0, wallet: { luna: NIM(2000).toString() }, grow: null, reason: null });
    expect(await json(await at(quiz, `/v1/save/split?address=${a}&luna=${NIM(2000)}`))).toEqual(plain(a));
    expect(await json(await at(arcade, `/v1/save/split?address=${stranger}&luna=${NIM(2000)}`))).toEqual(plain(stranger));
    expect(await json(await at(quiz, `/v1/save/spend?address=${a}&luna=${NIM(100)}`))).toMatchObject({ spendPercent: 0, save: "0", total: NIM(100).toString(), staker: null });
    expect((await at(arcade, `/v1/save/split?code=SAVE-0000000&address=${a}&luna=1`)).status).toBe(400);
    expect((await at(arcade, `/v1/save/split?luna=1`)).status).toBe(400);
    expect((await at(arcade, `/v1/save/split?address=NQ00&luna=1`)).status).toBe(400);
  });

  it("quotes spend and save: the share on top, nothing when Grow can't take it", async () => {
    const { at, arcade, amaka, a, stakers, clock } = await ready();
    expect(await json(await at(arcade, `/v1/save/spend?address=${a}&luna=${NIM(100)}`))).toEqual({
      address: amaka.address, spendPercent: 5, price: NIM(100).toString(), save: NIM(5).toString(), total: NIM(105).toString(), staker: amaka.address, reason: null,
    });
    stakers.delete(amaka.address);
    clock.t += 2 * 60_000; // past the stake cache
    expect(await json(await at(arcade, `/v1/save/spend?address=${a}&luna=${NIM(100)}`))).toMatchObject({ save: "0", total: NIM(100).toString(), staker: null, reason: "no-stake" });
    expect((await at(arcade, `/v1/save/spend?address=${a}&luna=0`)).status).toBe(400);
    expect((await at({}, `/v1/save/spend?address=${a}&luna=1`)).status).toBe(401);
  });

  it("records what an allowed app saved when the user paid it, and refuses the same from an app that wasn't allowed", async () => {
    const { app, at, arcade, quiz, amaka, a, txs } = await ready();
    const stakerHex = Buffer.from(nimiqAddressBytes(amaka.address)).toString("hex");
    txs.set("f".repeat(64), {
      hash: "f".repeat(64), blockNumber: 65_966_400, from: APP_PAYOUT, to: STAKING_CONTRACT, value: NIM(5), recipientData: `06${stakerHex}`, senderData: "",
      executionResult: true, confirmations: 3, timestamp: T,
    });
    const report = (who: Record<string, string>, body: Record<string, unknown>) => app.request("/v1/save/receipts", post({ address: amaka.address, payoutId: "spend-order-7", growTx: "f".repeat(64), ...body }, who));
    expect(await json(await report(arcade, { source: "spend" }))).toEqual({ growTx: "recorded" });
    const refused = await report(quiz, { source: "spend" });
    expect(refused.status).toBe(404);
    expect(await errorOf(refused)).toMatch(/hasn't allowed your app/);
    expect((await report(arcade, { source: "gift" })).status).toBe(400);
    expect((await report(arcade, { code: "SAVE-0000000" })).status).toBe(400);

    const me = await json(await at({}, `/v1/save/me?address=${a}`));
    expect(me).toMatchObject({ savePercent: 30, spendPercent: 5, apps: [{ name: "Arcade" }] });
    expect(me.receipts).toEqual([expect.objectContaining({ app: "Arcade", kind: "grow", source: "spend", luna: NIM(5).toString() })]);
    const activity = await json(await at({}, `/v1/save/activity?address=${a}`));
    expect(activity.payments).toEqual([expect.objectContaining({ payoutId: "spend-order-7", app: "Arcade", source: "spend", growLuna: NIM(5).toString(), walletLuna: "0" })]);
  });

  it("names the apps people can allow, and keeps names readable and unique", async () => {
    const { app } = await ready();
    expect((await json(await app.request("/v1/save/apps"))).apps.map((x: { name: string }) => x.name)).toEqual(["Arcade", "Quiz Night"]);
    const add = (name: string) => app.request("/v1/admin/save/apps", post({ name, payoutAddresses: [APP_PAYOUT] }, { Authorization: "Bearer admin-secret" }));
    expect(await errorOf(await add("arcade"))).toMatch(/already an app called arcade/);
    expect((await add("Arcade, Quiz")).status).toBe(400);
    expect((await add("")).status).toBe(400);
  });

  it("changes which apps are allowed with a new signed rule, refuses unknown names, and keeps them for an older rule", async () => {
    const { app, at, arcade, quiz, amaka, a } = await ready();
    const unknown = await app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address, { spendPercent: 5, apps: ["Arcade", "Nobody"], catchUp: "weekly" }))));
    expect(await errorOf(unknown)).toMatch(/doesn't know an app called Nobody/);
    expect(await json(await app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address, { spendPercent: 10, apps: ["quiz night"], catchUp: "daily" })))))).toMatchObject({ spendPercent: 10 });
    expect((await json(await at(quiz, `/v1/save/split?address=${a}&luna=${NIM(10)}`))).grow).not.toBeNull();
    expect((await json(await at(arcade, `/v1/save/split?address=${a}&luna=${NIM(10)}`))).grow).toBeNull();
    // A rule in the older format, without Spend and Apps, changes only the share of payouts.
    await app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address, { savePercent: 50 }))));
    expect(await json(await at({}, `/v1/save/me?address=${a}`))).toMatchObject({ savePercent: 50, spendPercent: 10, catchUp: "daily", apps: [{ name: "Quiz Night" }] });
  });
});

describe("the catch-up", () => {
  const HTLC = "NQ89 4VDF DQ8Q JEGL KX8U A1HC DE6K A78Y CJR5";
  const SHOP = "NQ09 XHGH TP20 4444 4444 4444 4444 4444 4444";
  const DAY = 86_400_000;
  /** Amaka saves 5% when she pays, weekly. She turned it on at T, Wednesday 4 November, so her first week ends on Monday 9 November (Lagos). */
  async function ready() {
    const f = setup();
    const amaka = account();
    f.stake(amaka.address);
    await f.app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address, { spendPercent: 5, apps: [], catchUp: "weekly" }))));
    const tx = (hash: string, from: string, to: string, nim: number, at: number, over: Partial<NimiqTransaction> = {}) =>
      f.txs.set(hash.repeat(64), { hash: hash.repeat(64), blockNumber: 1, from, to, value: NIM(nim), recipientData: "", senderData: "", executionResult: true, confirmations: 1, timestamp: at, ...over });
    const catchUp = async () => json(await f.app.request(`/v1/save/catchup?address=${encodeURIComponent(amaka.address)}&tzOffsetMinutes=60`));
    return { ...f, amaka, tx, catchUp, stakeHex: `06${Buffer.from(nimiqAddressBytes(amaka.address)).toString("hex")}` };
  }

  it("waits for the first week to end, then asks for 5% of what was spent, less what apps already saved", async () => {
    const { catchUp, clock, tx, amaka, store } = await ready();
    expect(await catchUp()).toMatchObject({ status: "waiting", every: "weekly", spendPercent: 5, next: Date.UTC(2026, 10, 8, 23) });
    // Nimiq Pay moves her NIM into an HTLC and pays the shop from it; an app saved 10 NIM when she paid it.
    // So 5% of the 990 spent on things is 49.5 NIM, less the 10 already saved: 39.5 NIM.
    tx("1", amaka.address, HTLC, 1_500, T + 3_600_000, { toType: 2, flags: 1 });
    tx("2", HTLC, SHOP, 1_000, T + 7_200_000);
    tx("3", HTLC, amaka.address, 500, T + 2 * DAY); // the rest handed back: not spending
    await store.addReceipt({ txHash: "4".repeat(64), code: "X", address: amaka.address, appId: "arcade", kind: "grow", source: "spend", luna: NIM(10).toString(), payoutId: "s1", blockNumber: 1, createdAt: T + DAY });
    clock.t = T + 7 * DAY;
    expect(await catchUp()).toMatchObject({ status: "due", from: T, to: Date.UTC(2026, 10, 8, 23), spent: NIM(1000).toString(), alreadySaved: NIM(10).toString(), owed: "3950000", complete: true, growOpen: true });
  });

  it("is settled once she adds at least what's owed to her stake, from the card or herself, and starts again from there", async () => {
    const { catchUp, clock, tx, amaka, stakeHex } = await ready();
    tx("1", amaka.address, HTLC, 1_500, T + 3_600_000, { toType: 2, flags: 1 });
    tx("2", HTLC, SHOP, 1_000, T + 7_200_000);
    clock.t = T + 7 * DAY;
    expect((await catchUp()).owed).toBe(NIM(50).toString());
    // Too little doesn't settle it, and the card asks only for the rest. Nimiq Pay sends her add-stake from the HTLC.
    tx("5", HTLC, STAKING_CONTRACT, 20, clock.t, { recipientData: stakeHex });
    clock.t += 2 * 60_000;
    expect(await catchUp()).toMatchObject({ status: "due", paid: NIM(20).toString(), owed: NIM(30).toString() });
    tx("6", HTLC, STAKING_CONTRACT, 30, clock.t, { recipientData: stakeHex });
    clock.t += 2 * 60_000;
    expect((await catchUp()).status).toBe("done");
    expect(await catchUp()).toMatchObject({ status: "waiting", from: Date.UTC(2026, 10, 8, 23), to: Date.UTC(2026, 10, 8, 23) });
  });

  it("counts a payment Errand only sees after the next period has started", async () => {
    const f = setup();
    const amaka = account();
    f.stake(amaka.address);
    await f.app.request("/v1/save/rule", post({ ...signed(amaka, rule(amaka.address, { spendPercent: 5, apps: [], catchUp: "daily" })), tzOffsetMinutes: 60 }));
    const set = (hash: string, from: string, to: string, nim: number, at: number, over: Partial<NimiqTransaction> = {}) =>
      f.txs.set(hash.repeat(64), { hash: hash.repeat(64), blockNumber: 1, from, to, value: NIM(nim), recipientData: "", senderData: "", executionResult: true, confirmations: 1, timestamp: at, ...over });
    set("1", amaka.address, HTLC, 1_500, T + 3_600_000, { toType: 2, flags: 1 });
    set("2", HTLC, SHOP, 1_000, T + 7_200_000);
    // She pays Wednesday's 50 NIM on Thursday, but Errand doesn't look again until Friday.
    const thursday = Date.UTC(2026, 10, 5, 11);
    set("3", HTLC, STAKING_CONTRACT, 50, thursday, { recipientData: `06${Buffer.from(nimiqAddressBytes(amaka.address)).toString("hex")}` });
    f.clock.t = Date.UTC(2026, 10, 6, 11);
    const r = await json(await f.app.request(`/v1/save/catchup?address=${encodeURIComponent(amaka.address)}`));
    expect(r).toMatchObject({ status: "done", paid: NIM(50).toString(), owed: "0" });
  });

  it("starts afresh when the share changes, and keeps the time zone the rule was saved in", async () => {
    const { app, tx, amaka, clock, catchUp } = await ready();
    tx("1", amaka.address, HTLC, 1_500, T + 3_600_000, { toType: 2, flags: 1 });
    tx("2", HTLC, SHOP, 1_000, T + 7_200_000);
    clock.t = T + DAY;
    // Raised to 20% a day later, saved from a phone in Lagos: the earlier spending isn't charged at the new rate.
    const changed = await app.request("/v1/save/rule", post({ ...signed(amaka, rule(amaka.address, { spendPercent: 20, apps: [], catchUp: "weekly", time: new Date(clock.t).toISOString() })), tzOffsetMinutes: 60 }));
    expect(changed.status).toBe(200);
    clock.t = T + 7 * DAY;
    expect(await catchUp()).toMatchObject({ status: "nothing", from: T + DAY, spent: "0", owed: "0" });
    // The phone now says UTC, but weeks still start at midnight in Lagos.
    expect((await json(await app.request(`/v1/save/catchup?address=${encodeURIComponent(amaka.address)}&tzOffsetMinutes=0`))).next).toBe(Date.UTC(2026, 10, 15, 23));
  });

  it("is off without a share to save when paying", async () => {
    const f = setup();
    const amaka = account();
    f.stake(amaka.address);
    await f.app.request("/v1/save/rule", post(signed(amaka, rule(amaka.address))));
    expect(await json(await f.app.request(`/v1/save/catchup?address=${encodeURIComponent(amaka.address)}`))).toEqual({ status: "off", every: "weekly", spendPercent: 0 });
    expect(await json(await f.app.request(`/v1/save/catchup?address=${encodeURIComponent(account().address)}`))).toEqual({ status: "off", every: null, spendPercent: 0 });
  });

  it("shows Grow transactions Nimiq Pay sent from the user's HTLC in Activity", async () => {
    const { app, tx, amaka, stakeHex } = await ready();
    tx("1", amaka.address, HTLC, 1_500, T + 3_600_000, { toType: 2, flags: 1 });
    tx("7", HTLC, STAKING_CONTRACT, 100, T + 7_200_000, { recipientData: stakeHex });
    const r = await json(await app.request(`/v1/save/activity?address=${encodeURIComponent(amaka.address)}`));
    expect(r.grow).toEqual([expect.objectContaining({ kind: "added", luna: NIM(100).toString() })]);
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
      const fresh = { savePercent: 30, spendPercent: 0, appIds: [], catchUpEvery: "weekly" as const, catchUpFrom: 0, tzOffsetMinutes: null, createdAt: T, updatedAt: T, revokedAt: null };
      expect(await store.insertCode({ code: "AAAAAAA", address: "NQ1", ...fresh })).toBe(true);
      expect(await store.insertCode({ code: "AAAAAAA", address: "NQ2", ...fresh, savePercent: 10 })).toBe(false);
      expect(await store.activeCodeByAddress("NQ1")).toMatchObject({ savePercent: 30, spendPercent: 0, appIds: [], catchUpEvery: "weekly", catchUpFrom: 0 });
      await store.updateRule("AAAAAAA", { savePercent: 40, spendPercent: 5, appIds: ["app1", "app2"], catchUpEvery: "monthly", catchUpFrom: T, tzOffsetMinutes: -300 }, T + 1);
      expect(await store.activeCodeByAddress("NQ1")).toMatchObject({
        code: "AAAAAAA", savePercent: 40, spendPercent: 5, appIds: ["app1", "app2"], catchUpEvery: "monthly", catchUpFrom: T, tzOffsetMinutes: -300, updatedAt: T + 1,
      });
      await store.revoke("AAAAAAA", T + 2);
      expect(await store.activeCode("AAAAAAA")).toBeUndefined();
      expect(await store.activeCodeByAddress("NQ1")).toBeUndefined();

      expect(await store.useNonce("n1", T)).toBe(true);
      expect(await store.useNonce("n1", T + 1)).toBe(false);
      expect(await store.useNonce("n1", T + 86_400_001)).toBe(true); // forgotten after a day

      await store.addApp({ id: "app1", name: "Arcade", keyHash: "h1", payoutAddresses: ["NQ9", "NQ8"], createdAt: T });
      expect(await store.appByKeyHash("h1")).toMatchObject({ id: "app1", payoutAddresses: ["NQ9", "NQ8"] });
      expect(await store.listApps()).toHaveLength(1);

      const r = { txHash: "t1", code: "AAAAAAA", address: "NQ1", appId: "app1", kind: "grow" as const, source: "payout" as const, luna: "600", payoutId: "p", blockNumber: 5, createdAt: T };
      await store.addReceipt(r);
      await store.addReceipt({ ...r, luna: "999" }); // replay is ignored
      const spent = { ...r, txHash: "t2", source: "spend" as const, luna: "5", payoutId: "spend-1", createdAt: T + 1 };
      await store.addReceipt(spent);
      expect(await store.receiptsForAddress("NQ1", 10)).toEqual([spent, r]);

      const sp = { appId: "app1", payoutId: "p1", code: "AAAAAAA", address: "NQ1", walletLuna: "2000", growLuna: "0", reason: "no-stake" as const, savePercent: 30, createdAt: T };
      await store.addSplit(sp);
      await store.addSplit({ ...sp, growLuna: "600", reason: null }); // a retried payout keeps the first split
      await store.addSplit({ ...sp, appId: "app2", reason: null, createdAt: T + 1 });
      expect(await store.splitsForAddress("NQ1", 10)).toEqual([{ ...sp, appId: "app2", reason: null, createdAt: T + 1 }, sp]);

      expect(await store.lastCatchUp("NQ1")).toBeUndefined();
      const cu = { address: "NQ1", periodTo: T, txHash: "c1", luna: "4000000", createdAt: T + 5 };
      await store.addCatchUp(cu);
      await store.addCatchUp({ ...cu, periodTo: T + 99 }); // the same transaction can't settle twice
      await store.addCatchUp({ ...cu, txHash: "c2", periodTo: T + 7 });
      expect(await store.lastCatchUp("NQ1")).toEqual({ ...cu, txHash: "c2", periodTo: T + 7 });
    });
  }
});
