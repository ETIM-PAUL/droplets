import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import type { Env as HonoEnv, Hono } from "hono";
import {
  formatSaveCode,
  MIN_STAKE_LUNA,
  newSaveCode,
  nimiqAddressBytes,
  nimiqAddressFromPublicKey,
  nimiqMessageHash,
  parseNimiqAddress,
  parseSaveCode,
  parseSaveMessage,
  releaseBlock,
  splitPayout,
  STAKING_CONTRACT,
  type GrowState,
  type NimiqRpc,
  type StakerState,
} from "@railkit/core";
import { answerSavingsQuestion, looksEnglish, parseSave, phraseSavingsAnswer, type SavePeriod, type SaveQuestion, type SavingsClassifier, type SavingsFacts, type SavingsPhraser } from "@railkit/agent";
import { rateLimiter } from "../rate-limit";
import type { SaveApp, SaveStore } from "./store";

export interface SaveDeps {
  store: SaveStore;
  chain: Pick<NimiqRpc, "staker" | "validator" | "activeValidators" | "transaction" | "blockNumber">;
  network: "mainnet" | "testnet";
  /** Validators shown first when opening Grow: address and a name people recognise. */
  recommended?: { address: string; name: string }[];
  /** Ed25519 check of Nimiq Pay's signature; node:crypto by default. */
  verifySignature?: (hash: Uint8Array, publicKeyHex: string, signatureHex: string) => boolean;
}

interface Helpers {
  bad: (message: string, status?: 400 | 401 | 403 | 404 | 429 | 502 | 503) => Response;
  clientKey: (h: (n: string) => string | undefined) => string;
  admin: (authorization: string | undefined) => boolean;
  now: () => number;
  log: (msg: string, data?: Record<string, unknown>) => void;
  /** Rewords answers to questions not in English. Optional; without it, answers stay in English. */
  phraser?: SavingsPhraser;
  /** Picks the kind of question for messages that aren't English. Optional. */
  classifier?: SavingsClassifier;
  /** The chat's shared daily budget for model calls. */
  allowModel?: () => boolean;
}

const QUESTION_KINDS: SaveQuestion[] = ["balance", "period", "release", "why-wallet", "code", "share", "apps", "rewards", "other"];
const PERIOD_KINDS: SavePeriod[] = ["today", "week", "month", "last-month"];

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/** Nimiq Pay signs the message hash with the account's Ed25519 key. */
export function verifyEd25519(hash: Uint8Array, publicKeyHex: string, signatureHex: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex) || !/^[0-9a-f]{128}$/i.test(signatureHex)) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
    return verify(null, hash, key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

const MAX_CLOCK_SKEW_MS = 10 * 60_000;
const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const lunaJson = (s: StakerState) => ({ active: s.active.toString(), inactive: s.inactive.toString(), inactiveFrom: s.inactiveFrom, retired: s.retired.toString(), delegation: s.delegation });

/** Small time-boxed cache, so one busy app can't turn every payout into several node calls. */
function cache<T>(ttlMs: number, now: () => number) {
  const m = new Map<string, { at: number; v: T }>();
  return async (key: string, load: () => Promise<T>): Promise<T> => {
    const hit = m.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.v;
    const v = await load();
    m.set(key, { at: now(), v });
    if (m.size > 5_000) for (const [k, e] of m) if (now() - e.at >= ttlMs) m.delete(k);
    return v;
  };
}

/**
 * Errand Save, phase 1. Users set their rule with a message signed in Nimiq Pay; paying apps look the
 * code up with their app key and pay the user directly. The server never holds or moves anyone's NIM.
 */
export function mountSaveRoutes<E extends HonoEnv>(app: Hono<E>, s: SaveDeps, h: Helpers) {
  const { bad, now, log } = h;
  const verifySig = s.verifySignature ?? verifyEd25519;
  const ruleLimit = rateLimiter(20, 60_000, now);
  const readLimit = rateLimiter(120, 60_000, now);
  const appLimit = rateLimiter(600, 60_000, now);
  const askLimit = rateLimiter(30, 60_000, now);
  const stakers = cache<StakerState | null>(60_000, now);
  const validators = cache<{ jailedFrom: number | null } | null>(10 * 60_000, now);
  const validatorList = cache<{ address: string; stakeLuna: string; numStakers: number }[]>(10 * 60_000, now);

  const ip = (c: { req: { header(n: string): string | undefined } }) => h.clientKey((n) => c.req.header(n));

  async function growState(address: string, fresh = false): Promise<{ grow: GrowState; jailedFrom: number | null }> {
    const staker = fresh ? await s.chain.staker(address) : await stakers(address, () => s.chain.staker(address));
    if (!staker) return { grow: { open: false, reason: "no-stake" }, jailedFrom: null };
    const v = await validators(staker.delegation, async () => {
      const x = await s.chain.validator(staker.delegation);
      return x && { jailedFrom: x.jailedFrom };
    });
    if (!v) return { grow: { open: false, reason: "validator-gone" }, jailedFrom: null };
    return { grow: { open: true, staker }, jailedFrom: v.jailedFrom };
  }

  async function appFrom(authorization: string | undefined): Promise<SaveApp | undefined> {
    const key = authorization?.replace(/^Bearer /i, "").trim();
    if (!key || !/^rk_save_[0-9a-f]{64}$/.test(key)) return undefined;
    return s.store.appByKeyHash(sha256Hex(key));
  }

  // ---- For the user, from the Mini App.

  /** Set or revoke the rule. The body is the message the user signed in Nimiq Pay, with the key and signature. */
  app.post("/v1/save/rule", async (c) => {
    if (!ruleLimit(ip(c))) return bad("Too many tries in a short time. Wait a minute.", 429);
    const body = (await c.req.json().catch(() => null)) as { message?: unknown; publicKey?: unknown; signature?: unknown } | null;
    const message = typeof body?.message === "string" ? body.message : "";
    const publicKey = typeof body?.publicKey === "string" ? body.publicKey.toLowerCase() : "";
    const signature = typeof body?.signature === "string" ? body.signature.toLowerCase() : "";
    const m = parseSaveMessage(message);
    if (!m.ok) return bad(m.error.message);
    if (Math.abs(now() - Date.parse(m.value.time)) > MAX_CLOCK_SKEW_MS) return bad("That request is too old. Try again.");
    let signer: string;
    try {
      signer = nimiqAddressFromPublicKey(publicKey);
    } catch {
      return bad("Nimiq Pay's signature is missing. Try again.");
    }
    if (signer !== m.value.address) return bad("That was signed by a different Nimiq account. Use the account you're saving with.", 403);
    if (!verifySig(nimiqMessageHash(message), publicKey, signature)) return bad("Nimiq Pay's signature didn't check out. Try again.", 403);
    if (!(await s.store.useNonce(m.value.nonce, now()))) return bad("That request was already used. Try again.");

    const address = m.value.address;
    const existing = await s.store.activeCodeByAddress(address);
    if (m.value.action === "revoke") {
      if (existing) await s.store.revoke(existing.code, now());
      log("save code revoked", { code: existing?.code ?? null });
      return c.json({ revoked: true });
    }
    const savePercent = m.value.savePercent!;
    if (existing) {
      await s.store.updatePercent(existing.code, savePercent, now());
      log("save rule changed", { code: existing.code, savePercent });
      return c.json({ code: formatSaveCode(existing.code), address, savePercent });
    }
    // A new code only once Grow is open, so nobody hands out a code that can't save anything yet.
    // Read fresh: the user has usually just opened Grow a moment ago.
    try {
      const { grow } = await growState(address, true);
      if (!grow.open || grow.staker.active + grow.staker.inactive < MIN_STAKE_LUNA) {
        return bad("Open Grow first: stake at least 100 NIM, then get your save code.", 403);
      }
    } catch (e) {
      log("save grow check failed", { error: String(e) });
      return bad("Couldn't reach the Nimiq network. Try again in a minute.", 502);
    }
    for (let i = 0; i < 5; i++) {
      const code = newSaveCode();
      if (await s.store.insertCode({ code, address, savePercent, createdAt: now(), updatedAt: now(), revokedAt: null })) {
        log("save code created", { code, savePercent });
        return c.json({ code: formatSaveCode(code), address, savePercent });
      }
    }
    return bad("Couldn't make a save code just now. Try again.", 503);
  });

  /** One user's savings: the code and rule from our records, Grow from the chain, payments in and how they split. */
  async function loadSavings(address: string, fresh: boolean) {
    const [code, { grow, jailedFrom }, blockNumber, receipts, splits, apps] = await Promise.all([
      s.store.activeCodeByAddress(address),
      growState(address, fresh),
      s.chain.blockNumber(),
      s.store.receiptsForAddress(address, 50),
      s.store.splitsForAddress(address, 20),
      s.store.listApps(),
    ]);
    const names = new Map(apps.map((a) => [a.id, a.name]));
    const staker = grow.open ? grow.staker : null;
    return {
      code, grow, staker, jailedFrom, blockNumber, receipts, splits,
      appName: (id: string) => names.get(id) ?? "An app",
      release: staker && staker.inactive > 0n && staker.inactiveFrom !== null ? releaseBlock(staker.inactiveFrom, jailedFrom) : null,
    };
  }

  /** Everything the savings screen shows: the code and rule, Grow from the chain, and verified payments in. */
  app.get("/v1/save/me", async (c) => {
    if (!readLimit(ip(c))) return bad("Too many requests. Wait a minute.", 429);
    const addr = parseNimiqAddress(c.req.query("address") ?? "");
    if (!addr.ok) return bad(addr.error.message);
    try {
      const x = await loadSavings(addr.value, c.req.query("fresh") === "1");
      return c.json({
        network: s.network,
        address: addr.value,
        code: x.code ? formatSaveCode(x.code.code) : null,
        savePercent: x.code?.savePercent ?? null,
        blockNumber: x.blockNumber,
        grow: x.staker && { ...lunaJson(x.staker), releaseBlock: x.release, validatorJailed: x.jailedFrom !== null },
        growClosed: x.grow.open ? null : x.grow.reason,
        receipts: x.receipts.map((r) => ({ txHash: r.txHash, app: x.appName(r.appId), kind: r.kind, luna: r.luna, at: r.createdAt })),
        splits: x.splits.map((r) => ({ payoutId: r.payoutId, app: x.appName(r.appId), walletLuna: r.walletLuna, growLuna: r.growLuna, reason: r.reason, savePercent: r.savePercent, at: r.createdAt })),
      });
    } catch (e) {
      log("save me failed", { error: String(e) });
      return bad("Couldn't reach the Nimiq network. Try again in a minute.", 502);
    }
  });

  /**
   * A question about the user's own savings ("when can I get my money?"). Rules decide what's being asked,
   * code works out the answer from the user's data, and a model may only reword it into the user's language.
   * Nothing here can move money.
   */
  app.post("/v1/save/ask", async (c) => {
    if (!askLimit(ip(c))) return bad("Too many questions in a short time. Wait a minute.", 429);
    const body = (await c.req.json().catch(() => null)) as { address?: unknown; question?: unknown; kind?: unknown; period?: unknown; tzOffsetMinutes?: unknown } | null;
    const addr = parseNimiqAddress(typeof body?.address === "string" ? body.address : "");
    if (!addr.ok) return bad(addr.error.message);
    const question = typeof body?.question === "string" ? body.question.trim() : "";
    if (!question || question.length > 300) return bad("Ask one question about your savings, under 300 characters.");
    // Which question: the kind the chat already worked out, else the rules, else (not English) the classifier.
    let ask: { question: SaveQuestion; period?: SavePeriod } | null = null;
    if (QUESTION_KINDS.includes(body?.kind as SaveQuestion)) {
      ask = { question: body!.kind as SaveQuestion, ...(PERIOD_KINDS.includes(body?.period as SavePeriod) ? { period: body!.period as SavePeriod } : {}) };
    } else {
      const parsed = parseSave(question);
      if (parsed?.save.action === "ask") ask = { question: parsed.save.question ?? "other", period: parsed.save.period };
      else if (!parsed && h.classifier && !looksEnglish(question) && (h.allowModel?.() ?? true)) ask = await h.classifier(question).catch(() => null);
    }
    if (!ask) return bad("Ask a question about your savings, like \u201cWhen can I get my money?\u201d");
    const tz = body?.tzOffsetMinutes;
    const tzOffsetMinutes = typeof tz === "number" && Number.isInteger(tz) && Math.abs(tz) <= 14 * 60 ? tz : 0;
    try {
      const x = await loadSavings(addr.value, false);
      const facts: SavingsFacts = {
        code: x.code ? formatSaveCode(x.code.code) : null,
        savePercent: x.code?.savePercent ?? null,
        grow: x.staker && { active: x.staker.active, inactive: x.staker.inactive, retired: x.staker.retired, releaseBlock: x.release, validatorJailed: x.jailedFrom !== null },
        growClosed: x.grow.open ? null : x.grow.reason,
        blockNumber: x.blockNumber,
        receipts: x.receipts.map((r) => ({ app: x.appName(r.appId), kind: r.kind, luna: BigInt(r.luna), at: r.createdAt })),
        splits: x.splits.map((r) => ({ app: x.appName(r.appId), walletLuna: BigInt(r.walletLuna), growLuna: BigInt(r.growLuna), reason: r.reason, savePercent: r.savePercent, at: r.createdAt })),
      };
      const kind = ask.question;
      const answer = answerSavingsQuestion(ask, facts, { now: now(), tzOffsetMinutes });
      const out = await phraseSavingsAnswer(question, answer, { phraser: h.phraser, allowModel: h.allowModel, log });
      // What was asked is not logged: it's the user's own words. Only the kind of question is.
      log("save question", { question: kind, source: out.source });
      return c.json({ answer: out.text, question: kind, source: out.source });
    } catch (e) {
      log("save ask failed", { error: String(e) });
      return bad("Couldn't reach the Nimiq network. Try again in a minute.", 502);
    }
  });

  /** Validators for opening Grow: our recommended ones first, then the rest of the active set by stake. */
  app.get("/v1/save/validators", async (c) => {
    try {
      const list = await validatorList("all", async () =>
        (await s.chain.activeValidators())
          .filter((v) => !v.retired && v.jailedFrom === null)
          .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0))
          .map((v) => ({ address: v.address, stakeLuna: v.balance.toString(), numStakers: v.numStakers })),
      );
      const names = new Map((s.recommended ?? []).map((r) => [r.address, r.name]));
      const recommended = list.filter((v) => names.has(v.address)).map((v) => ({ ...v, name: names.get(v.address)! }));
      const others = list.filter((v) => !names.has(v.address)).map((v) => ({ ...v, name: null }));
      return c.json({ validators: [...recommended, ...others] });
    } catch (e) {
      log("save validators failed", { error: String(e) });
      return bad("Couldn't reach the Nimiq network. Try again in a minute.", 502);
    }
  });

  // ---- For paying apps, server to server, with their app key.

  /** How to split a payment for this code: the wallet part and the Grow part, in luna. */
  app.get("/v1/save/split", async (c) => {
    const payer = await appFrom(c.req.header("authorization"));
    if (!payer) return bad("Missing or unknown app key.", 401);
    if (!appLimit(payer.id)) return bad("Too many lookups. Slow down.", 429);
    const code = parseSaveCode(c.req.query("code") ?? "");
    if (!code.ok) return bad(code.error.message);
    const raw = c.req.query("luna") ?? "";
    if (!/^[1-9]\d{0,15}$/.test(raw)) return bad("luna must be a whole number above 0.");
    // Optional: which payout this is. With it, the user can later ask why a payment went to their wallet.
    const payoutId = c.req.query("payoutId");
    if (payoutId !== undefined && !/^[\w:.-]{1,100}$/.test(payoutId)) return bad("payoutId: 1 to 100 letters, digits or _ : . -");
    const row = await s.store.activeCode(code.value);
    if (!row) return bad("No active save code like that. Pay the user's address instead.", 404);
    try {
      const { grow } = await growState(row.address);
      const split = splitPayout(BigInt(raw), row.savePercent, grow);
      if (payoutId) {
        await s.store.addSplit({
          appId: payer.id, payoutId, code: row.code, address: row.address, walletLuna: split.wallet.toString(), growLuna: split.grow.toString(),
          reason: split.reason, savePercent: row.savePercent, createdAt: now(),
        });
      }
      return c.json({
        code: formatSaveCode(row.code),
        address: row.address,
        savePercent: row.savePercent,
        wallet: { luna: split.wallet.toString() },
        grow: split.grow > 0n ? { luna: split.grow.toString(), staker: row.address } : null,
        reason: split.reason,
      });
    } catch (e) {
      log("save split failed", { error: String(e) });
      return bad("Couldn't reach the Nimiq network. Try again in a minute.", 502);
    }
  });

  /** An app reports what it sent. Each transaction is checked on-chain before it shows in the user's history. */
  app.post("/v1/save/receipts", async (c) => {
    const payer = await appFrom(c.req.header("authorization"));
    if (!payer) return bad("Missing or unknown app key.", 401);
    if (!appLimit(payer.id)) return bad("Too many requests. Slow down.", 429);
    const body = (await c.req.json().catch(() => null)) as { code?: unknown; payoutId?: unknown; walletTx?: unknown; growTx?: unknown } | null;
    const code = parseSaveCode(typeof body?.code === "string" ? body.code : "");
    if (!code.ok) return bad(code.error.message);
    const payoutId = typeof body?.payoutId === "string" && /^[\w:.-]{1,100}$/.test(body.payoutId) ? body.payoutId : "";
    if (!payoutId) return bad("payoutId is required: letters, digits and _ : . - only.");
    const txs = (["walletTx", "growTx"] as const)
      .map((k) => ({ k, hash: body?.[k] }))
      .filter((t): t is { k: "walletTx" | "growTx"; hash: string } => typeof t.hash === "string");
    if (txs.length === 0 || txs.some((t) => !/^[0-9a-f]{64}$/.test(t.hash))) return bad("Send walletTx and/or growTx as 64-character hex hashes.");
    const row = await s.store.activeCode(code.value);
    if (!row) return bad("No active save code like that.", 404);

    const from = new Set(payer.payoutAddresses);
    const stakerHex = hex(nimiqAddressBytes(row.address));
    const out: Record<string, "recorded" | "pending"> = {};
    try {
      for (const t of txs) {
        const tx = await s.chain.transaction(t.hash);
        if (!tx) {
          out[t.k] = "pending";
          continue;
        }
        if (!from.has(tx.from)) return bad(`${t.k} wasn't sent from one of this app's payout addresses.`, 403);
        if (!tx.executionResult) return bad(`${t.k} failed on-chain.`);
        const kind = t.k === "walletTx" ? "wallet" : "grow";
        const ok = kind === "wallet" ? tx.to === row.address : tx.to === STAKING_CONTRACT && tx.recipientData.startsWith(`06${stakerHex}`);
        if (!ok) return bad(kind === "wallet" ? "walletTx didn't pay this code's address." : "growTx isn't an add-stake into this code's Grow savings.");
        await s.store.addReceipt({
          txHash: tx.hash, code: row.code, address: row.address, appId: payer.id, kind, luna: tx.value.toString(), payoutId, blockNumber: tx.blockNumber, createdAt: now(),
        });
        out[t.k] = "recorded";
      }
    } catch (e) {
      log("save receipt failed", { error: String(e) });
      return bad("Couldn't reach the Nimiq network. Try again in a minute.", 502);
    }
    log("save receipt", { app: payer.id, code: row.code, ...out });
    return c.json(out);
  });

  // ---- Admin: which apps may look codes up. The key is shown once.

  app.post("/v1/admin/save/apps", async (c) => {
    if (!h.admin(c.req.header("authorization"))) return bad("Not found.", 404);
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; payoutAddresses?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 60) : "";
    if (!name) return bad("Give the app a name.");
    const raw = Array.isArray(body?.payoutAddresses) ? body.payoutAddresses : [];
    const addresses = raw.map((a) => parseNimiqAddress(typeof a === "string" ? a : ""));
    if (addresses.length === 0 || addresses.some((a) => !a.ok)) return bad("List the app's payout addresses as valid Nimiq addresses.");
    const apiKey = `rk_save_${randomBytes(32).toString("hex")}`;
    const id = randomUUID();
    await s.store.addApp({ id, name, keyHash: sha256Hex(apiKey), payoutAddresses: addresses.map((a) => (a.ok ? a.value : "")), createdAt: now() });
    log("save app added", { id, name });
    return c.json({ id, name, apiKey });
  });

  app.get("/v1/admin/save/apps", async (c) => {
    if (!h.admin(c.req.header("authorization"))) return bad("Not found.", 404);
    return c.json({ apps: (await s.store.listApps()).map(({ keyHash: _k, ...a }) => a) });
  });
}
