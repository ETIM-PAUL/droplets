import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import type { Env as HonoEnv, Hono } from "hono";
import {
  CATCH_UP_MAX_DAYS,
  catchUpOwed,
  catchUpWindow,
  formatSaveCode,
  growEvents,
  HTLC_LIFETIME_DAYS,
  isAppName,
  isOwn,
  MIN_STAKE_LUNA,
  newSaveCode,
  nextCatchUpPeriodStart,
  nimiqAddressBytes,
  nimiqAddressFromPublicKey,
  nimiqMessageHash,
  ownAddresses,
  ownHistory,
  parseNimiqAddress,
  parseSaveCode,
  parseSaveMessage,
  releaseBlock,
  spendSave,
  spentBetween,
  splitPayout,
  STAKING_CONTRACT,
  type GrowState,
  type NimiqRpc,
  type OwnHistory,
  type StakerState,
} from "@railkit/core";
import { answerSavingsQuestion, looksEnglish, parseSave, phraseSavingsAnswer, type SavePeriod, type SaveQuestion, type SavingsClassifier, type SavingsFacts, type SavingsPhraser } from "@railkit/agent";
import { rateLimiter } from "../rate-limit";
import { NO_USAGE, type AppEdit, type SaveApp, type SaveCodeRow, type SaveStore } from "./store";

export interface SaveDeps {
  store: SaveStore;
  chain: Pick<NimiqRpc, "staker" | "validator" | "activeValidators" | "transaction" | "transactionsByAddress" | "blockNumber">;
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
  /** Tells the team: here, that an app signed up and waits for review. */
  alert?: (text: string) => Promise<void>;
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
 * Droplets, phase 1. Users set their rule with a message signed in Nimiq Pay; paying apps look the
 * code up with their app key and pay the user directly. The server never holds or moves anyone's NIM.
 */
export function mountSaveRoutes<E extends HonoEnv>(app: Hono<E>, s: SaveDeps, h: Helpers) {
  const { bad, now, log } = h;
  const verifySig = s.verifySignature ?? verifyEd25519;
  const ruleLimit = rateLimiter(20, 60_000, now);
  const readLimit = rateLimiter(120, 60_000, now);
  const appLimit = rateLimiter(600, 60_000, now);
  const askLimit = rateLimiter(30, 60_000, now);
  /** Reads that skip the cache re-read whole histories from the node, so fewer of them. */
  const freshLimit = rateLimiter(30, 60_000, now);
  /** App sign-ups, per client: a few an hour. */
  const signupLimit = rateLimiter(3, 3_600_000, now);
  const stakers = cache<StakerState | null>(60_000, now);
  const validators = cache<{ jailedFrom: number | null } | null>(10 * 60_000, now);
  const validatorList = cache<{ address: string; stakeLuna: string; numStakers: number }[]>(10 * 60_000, now);
  const histories = cache<OwnHistory>(60_000, now);

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

  /**
   * The user's own accounts and their transactions: the wallet, and the HTLCs Nimiq Pay keeps their balance in, which
   * is where their payments and staking come from. Far enough back for the longest catch-up.
   */
  const historyOf = (address: string, fresh = false) => {
    const read = () => ownHistory(address, (a, max) => s.chain.transactionsByAddress(a, max), { since: now() - (CATCH_UP_MAX_DAYS + HTLC_LIFETIME_DAYS) * 86_400_000 });
    return fresh ? read() : histories(address, read);
  };

  async function appFrom(authorization: string | undefined): Promise<SaveApp | undefined> {
    const key = authorization?.replace(/^Bearer /i, "").trim();
    if (!key || !/^rk_save_[0-9a-f]{64}$/.test(key)) return undefined;
    return s.store.appByKeyHash(sha256Hex(key));
  }

  /**
   * The app calling, or the response to send it instead. An app waiting for review can't look anyone up yet:
   * otherwise anyone could sign up and try save codes until one gave away an address.
   */
  async function payerFrom(authorization: string | undefined): Promise<SaveApp | Response> {
    const payer = await appFrom(authorization);
    if (!payer) return bad("Missing or unknown app key.", 401);
    if (payer.pending) return bad("This app is waiting for review. Its key starts working once it's approved.", 403);
    if (!appLimit(payer.id)) return bad("Too many requests. Slow down.", 429);
    return payer;
  }

  /**
   * The rule behind an address, only if its owner allowed this app to recognise them. Someone without a rule
   * and someone who didn't allow the app look the same, so an app can't find out who saves with Droplets.
   */
  async function allowedSaver(address: string, payer: SaveApp): Promise<SaveCodeRow | undefined> {
    const row = await s.store.activeCodeByAddress(address);
    return row && row.appIds.includes(payer.id) ? row : undefined;
  }

  /** Apps people can allow, by name. Names that can't be written in a signed rule are left out. */
  const namedApps = async () => (await s.store.listApps()).filter((a) => !a.pending && isAppName(a.name));

  // ---- For the user, from the Mini App.

  /** Set or revoke the rule. The body is the message the user signed in Nimiq Pay, with the key and signature. */
  app.post("/v1/save/rule", async (c) => {
    if (!ruleLimit(ip(c))) return bad("Too many tries in a short time. Wait a minute.", 429);
    const body = (await c.req.json().catch(() => null)) as { message?: unknown; publicKey?: unknown; signature?: unknown; tzOffsetMinutes?: unknown } | null;
    const message = typeof body?.message === "string" ? body.message : "";
    // Not signed: it only decides when the user's day, week or month starts.
    const tz = body?.tzOffsetMinutes;
    const tzOffsetMinutes = typeof tz === "number" && Number.isInteger(tz) && Math.abs(tz) <= 14 * 60 ? tz : null;
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
    if (m.value.savePercent! < 10) return bad("The share to save has to be a whole percent from 10 to 100. To stop saving, turn your save code off.");
    // The apps the user named, as ids. A rule signed before apps and spending existed keeps what was there.
    let appIds = existing?.appIds ?? [];
    if (m.value.apps) {
      const byName = new Map((await namedApps()).map((a) => [a.name.toLowerCase(), a.id]));
      const unknown = m.value.apps.find((n) => !byName.has(n.toLowerCase()));
      if (unknown) return bad(`Droplets doesn't know an app called ${unknown}. Reload and try again.`);
      appIds = m.value.apps.map((n) => byName.get(n.toLowerCase())!);
    }
    const spendPercent = m.value.spendPercent ?? existing?.spendPercent ?? 0;
    // A catch-up only covers spending under the share it asks for: turning it on or changing it starts afresh.
    const changed = spendPercent !== (existing?.spendPercent ?? 0);
    const rule = {
      savePercent: m.value.savePercent!, spendPercent, appIds, catchUpEvery: m.value.catchUp ?? existing?.catchUpEvery ?? "weekly",
      catchUpFrom: changed ? now() : existing?.catchUpFrom || existing?.updatedAt || now(),
      tzOffsetMinutes: tzOffsetMinutes ?? existing?.tzOffsetMinutes ?? null,
    };
    const reply = (code: string) => c.json({ code: formatSaveCode(code), address, savePercent: rule.savePercent, spendPercent: rule.spendPercent, appIds, catchUp: rule.catchUpEvery });
    if (existing) {
      await s.store.updateRule(existing.code, rule, now());
      log("save rule changed", { code: existing.code, savePercent: rule.savePercent, spendPercent: rule.spendPercent, apps: appIds.length });
      return reply(existing.code);
    }
    // A new code only once Grow is open, so nobody hands out a code that can't save anything yet.
    // Read fresh: the user has usually just opened Grow a moment ago.
    try {
      const { grow } = await growState(address, true);
      if (!grow.open || grow.staker.active + grow.staker.inactive < MIN_STAKE_LUNA) {
        return bad("Open your savings first: stake at least 100 NIM, then get your save code.", 403);
      }
    } catch (e) {
      log("save grow check failed", { error: String(e) });
      return bad("Couldn't reach the Nimiq network. Try again in a minute.", 502);
    }
    for (let i = 0; i < 5; i++) {
      const code = newSaveCode();
      if (await s.store.insertCode({ code, address, ...rule, createdAt: now(), updatedAt: now(), revokedAt: null })) {
        log("save code created", { code, savePercent: rule.savePercent, spendPercent: rule.spendPercent, apps: appIds.length });
        return reply(code);
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
        spendPercent: x.code?.spendPercent ?? null,
        catchUp: x.code?.catchUpEvery ?? null,
        apps: (x.code?.appIds ?? []).map((id) => ({ id, name: x.appName(id) })),
        blockNumber: x.blockNumber,
        grow: x.staker && { ...lunaJson(x.staker), releaseBlock: x.release, validatorJailed: x.jailedFrom !== null },
        growClosed: x.grow.open ? null : x.grow.reason,
        receipts: x.receipts.map((r) => ({ txHash: r.txHash, app: x.appName(r.appId), kind: r.kind, source: r.source, luna: r.luna, at: r.createdAt })),
        splits: x.splits.map((r) => ({ payoutId: r.payoutId, app: x.appName(r.appId), walletLuna: r.walletLuna, growLuna: r.growLuna, reason: r.reason, savePercent: r.savePercent, at: r.createdAt })),
      });
    } catch (e) {
      log("save me failed", { error: String(e) });
      return bad("Couldn't reach the Nimiq network. Try again in a minute.", 502);
    }
  });

  /**
   * The savings history, newest first: each payment in with the code (its wallet and Grow parts, as checked
   * on-chain) and the person's own Grow transactions. `grow` is null when the chain couldn't be read just now.
   */
  app.get("/v1/save/activity", async (c) => {
    if (!readLimit(ip(c))) return bad("Too many requests. Wait a minute.", 429);
    const addr = parseNimiqAddress(c.req.query("address") ?? "");
    if (!addr.ok) return bad(addr.error.message);
    const [receipts, splits, apps, txs] = await Promise.all([
      s.store.receiptsForAddress(addr.value, 100),
      s.store.splitsForAddress(addr.value, 100),
      s.store.listApps(),
      historyOf(addr.value).catch((e) => (log("save activity chain read failed", { error: String(e) }), null)),
    ]);
    const names = new Map(apps.map((a) => [a.id, a.name]));
    const payments = new Map<string, { payoutId: string; app: string; source: "payout" | "spend"; walletLuna: bigint; growLuna: bigint; at: number; reason: string | null }>();
    for (const r of receipts) {
      const key = `${r.appId}:${r.payoutId}`;
      const p = payments.get(key) ?? { payoutId: r.payoutId, app: names.get(r.appId) ?? "An app", source: r.source, walletLuna: 0n, growLuna: 0n, at: 0, reason: null };
      if (r.kind === "grow") p.growLuna += BigInt(r.luna);
      else p.walletLuna += BigInt(r.luna);
      p.at = Math.max(p.at, r.createdAt);
      payments.set(key, p);
    }
    // Why nothing went to Grow, from the split the app was given.
    for (const sp of splits) {
      const p = payments.get(`${sp.appId}:${sp.payoutId}`);
      if (p && p.growLuna === 0n) p.reason = sp.reason;
    }
    return c.json({
      payments: [...payments.values()].sort((a, b) => b.at - a.at).map((p) => ({ ...p, walletLuna: p.walletLuna.toString(), growLuna: p.growLuna.toString() })),
      grow: txs && growEvents(addr.value, txs.txs, [addr.value, ...txs.htlcs]).map((e) => ({ ...e, luna: e.luna.toString() })),
    });
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

  /**
   * The catch-up: the user's share of what they spent since the last one, outside apps that already saved when they
   * paid, ready to save in one approval. It counts as settled once the user's own add-stakes since the end of the
   * period reach what's owed, whether from this card or from adding to Grow themselves.
   */
  app.get("/v1/save/catchup", async (c) => {
    if (!readLimit(ip(c))) return bad("Too many requests. Wait a minute.", 429);
    const addr = parseNimiqAddress(c.req.query("address") ?? "");
    if (!addr.ok) return bad(addr.error.message);
    const row = await s.store.activeCodeByAddress(addr.value);
    if (!row || row.spendPercent === 0) return c.json({ status: "off", every: row?.catchUpEvery ?? null, spendPercent: row?.spendPercent ?? 0 });
    // The time zone saved with the rule, so boundaries don't move when the phone's does; the phone's until then.
    const tz = Number(c.req.query("tzOffsetMinutes") ?? "0");
    const offset = row.tzOffsetMinutes ?? (Number.isInteger(tz) && Math.abs(tz) <= 14 * 60 ? tz : 0);
    try {
      const last = await s.store.lastCatchUp(addr.value);
      const w = catchUpWindow(now(), row.catchUpEvery, offset, Math.max(row.catchUpFrom || row.updatedAt, last?.periodTo ?? 0));
      const base = { every: row.catchUpEvery, spendPercent: row.spendPercent, from: w.from, to: w.to, next: w.next };
      if (w.to <= w.from) return c.json({ status: "waiting", ...base });
      const fresh = c.req.query("fresh") === "1" && freshLimit(ip(c));
      const [h, receipts, { grow }] = await Promise.all([historyOf(addr.value, fresh), s.store.receiptsForAddress(addr.value, 500), growState(addr.value, fresh)]);
      const spent = spentBetween(h, w.from, w.to);
      // What apps already saved when the user paid them, in the same time: that spending has had its share.
      const saved = receipts.filter((r) => r.source === "spend" && r.kind === "grow" && r.createdAt >= w.from && r.createdAt < w.to).reduce((a, r) => a + BigInt(r.luna), 0n);
      const owed = catchUpOwed(spent, row.spendPercent, saved);
      // Paid by the user's own add-stakes since the first period in the window ended, whenever Droplets sees them, and
      // never ones that settled an earlier catch-up.
      const own = ownAddresses(h);
      const stakeHex = `06${hex(nimiqAddressBytes(addr.value))}`;
      const since = Math.max(nextCatchUpPeriodStart(w.from, row.catchUpEvery, offset), last?.createdAt ?? 0);
      const added = h.txs.filter(
        (t) => t.executionResult && t.timestamp >= since && t.hash !== last?.txHash && isOwn(own, t.from) && t.to === STAKING_CONTRACT && t.recipientData.toLowerCase().startsWith(stakeHex),
      );
      const paid = added.reduce((a, t) => a + t.value, 0n);
      const left = owed > paid ? owed - paid : 0n;
      const amounts = { spent: spent.toString(), alreadySaved: saved.toString(), paid: paid.toString(), owed: left.toString(), complete: h.coversFrom <= w.from, growOpen: grow.open };
      if (owed > 0n && left === 0n) {
        await s.store.addCatchUp({ address: addr.value, periodTo: w.to, txHash: added[0]!.hash, luna: owed.toString(), createdAt: now() });
        log("save catch-up settled", { every: row.catchUpEvery });
        return c.json({ status: "done", ...base, ...amounts });
      }
      return c.json({ status: left > 0n ? "due" : "nothing", ...base, ...amounts });
    } catch (e) {
      log("save catch-up failed", { error: String(e) });
      return bad("Couldn't reach the Nimiq network. Try again in a minute.", 502);
    }
  });

  /** The approved apps that save with Droplets: for people to pick which may recognise their address, and for the landing page. */
  app.get("/v1/save/apps", async (c) => {
    if (!readLimit(ip(c))) return bad("Too many requests. Wait a minute.", 429);
    return c.json({ apps: (await namedApps()).map((a) => ({ id: a.id, name: a.name, url: a.url ?? null })) });
  });

  /** The request body when it's a JSON object; null for anything else. */
  const jsonObject = async (c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown> | null> => {
    const b = await c.req.json().catch(() => null);
    return b !== null && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  };

  /**
   * An app's details from the sign-up form or the admin page, checked. Without `partial` every field is read (a missing
   * link or contact becomes null); with it, only the fields sent, so the admin page can change one thing at a time.
   */
  function readAppForm(body: Record<string, unknown> | null, o: { partial: boolean; contactRequired: boolean }): AppEdit | Response {
    const out: AppEdit = {};
    const has = (k: string) => !o.partial || (body !== null && k in body);
    if (has("name")) {
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!isAppName(name)) return bad("Give the app a name of up to 40 letters, digits, spaces or . ' & ! + -, with no commas.");
      out.name = name;
    }
    if (has("url")) {
      const raw = typeof body?.url === "string" ? body.url.trim() : "";
      if (!raw) out.url = null;
      else {
        const u = URL.canParse(raw) ? new URL(raw) : null;
        if (!u || u.protocol !== "https:" || raw.length > 200) return bad("The link must be an https:// address of up to 200 characters.");
        out.url = u.href;
      }
    }
    if (has("contact")) {
      const contact = typeof body?.contact === "string" ? body.contact.trim() : "";
      if (!contact && !o.contactRequired) out.contact = null;
      else if (contact.length < 3 || contact.length > 120 || /[\u0000-\u001f\u007f]/.test(contact)) {
        return bad("Say how to reach you: an email address or Telegram handle, up to 120 characters.");
      } else out.contact = contact;
    }
    if (has("payoutAddresses")) {
      const raw = Array.isArray(body?.payoutAddresses) ? body.payoutAddresses : [];
      const parsed = raw.map((a) => parseNimiqAddress(typeof a === "string" ? a : ""));
      if (parsed.length === 0 || parsed.length > 5 || parsed.some((a) => !a.ok)) return bad("List 1 to 5 Nimiq addresses the app pays from.");
      out.payoutAddresses = [...new Set(parsed.map((a) => (a.ok ? a.value : "")))];
    }
    return out;
  }

  /** Names are unique whatever their case, waiting apps included. */
  const nameTaken = (apps: SaveApp[], name: string, except?: string) => apps.some((a) => a.id !== except && a.name.toLowerCase() === name.toLowerCase());
  const newAppKey = () => `rk_save_${randomBytes(32).toString("hex")}`;

  /**
   * An app signs itself up from the landing page. It gets its key at once, shown only this time, but the key works
   * only after the team approves the app; until then the app isn't listed and people can't pick it.
   */
  app.post("/v1/save/apps/register", async (c) => {
    if (!readLimit(ip(c))) return bad("Too many requests. Wait a minute.", 429);
    const form = readAppForm(await jsonObject(c), { partial: false, contactRequired: true });
    if (form instanceof Response) return form;
    const { name = "", url = null, contact = null, payoutAddresses = [] } = form;
    const apps = await s.store.listApps();
    if (nameTaken(apps, name)) return bad(`There's already an app called ${name}.`);
    if (apps.filter((a) => a.pending).length >= 100) return bad("Sign-ups are paused while we review the apps already waiting. Try again tomorrow.", 503);
    // Only sign-ups that go through count, so fixing a typo in the form never locks anyone out.
    if (!signupLimit(ip(c))) return bad("Too many sign-ups from here. Try again in an hour.", 429);
    const apiKey = newAppKey();
    const id = randomUUID();
    await s.store.addApp({ id, name, keyHash: sha256Hex(apiKey), payoutAddresses, createdAt: now(), pending: true, url, contact });
    log("save app signed up", { id, name });
    void h.alert?.(`NEW APP waiting for review: ${JSON.stringify(name)}, ${url ? JSON.stringify(url) : "no link"}, contact ${JSON.stringify(contact)}. Approve with POST /v1/admin/save/apps/${id}/approve`)?.catch(() => undefined);
    return c.json({ id, name, apiKey, status: "pending" });
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

  /**
   * How to split a payment: the wallet part and the Grow part, in luna. For a save code, or for an address
   * whose owner allowed this app. Any other address gets "pay it all to the wallet", saver or not.
   */
  app.get("/v1/save/split", async (c) => {
    const payer = await payerFrom(c.req.header("authorization"));
    if (payer instanceof Response) return payer;
    const [rawCode, rawAddress] = [c.req.query("code"), c.req.query("address")];
    if ((rawCode === undefined) === (rawAddress === undefined)) return bad("Send either a save code or an address.");
    const raw = c.req.query("luna") ?? "";
    if (!/^[1-9]\d{0,15}$/.test(raw)) return bad("luna must be a whole number above 0.");
    // Optional: which payout this is. With it, the user can later ask why a payment went to their wallet.
    const payoutId = c.req.query("payoutId");
    if (payoutId !== undefined && !/^[\w:.-]{1,100}$/.test(payoutId)) return bad("payoutId: 1 to 100 letters, digits or _ : . -");
    let row: SaveCodeRow | undefined;
    if (rawAddress !== undefined) {
      const addr = parseNimiqAddress(rawAddress);
      if (!addr.ok) return bad(addr.error.message);
      row = await allowedSaver(addr.value, payer);
      if (!row) return c.json({ code: null, address: addr.value, savePercent: 0, wallet: { luna: raw }, grow: null, reason: null });
    } else {
      const code = parseSaveCode(rawCode!);
      if (!code.ok) return bad(code.error.message);
      row = await s.store.activeCode(code.value);
      if (!row) return bad("No active save code like that. Pay the user's address instead.", 404);
    }
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
        // The code only goes back to an app that already had it.
        code: rawCode !== undefined ? formatSaveCode(row.code) : null,
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

  /**
   * Spend and save: what to charge when this address pays the app `luna`. The saved part goes on top, and the app
   * puts it into the payer's stake once the payment arrives. Without a rule that allows this app, nothing goes on top.
   */
  app.get("/v1/save/spend", async (c) => {
    const payer = await payerFrom(c.req.header("authorization"));
    if (payer instanceof Response) return payer;
    const addr = parseNimiqAddress(c.req.query("address") ?? "");
    if (!addr.ok) return bad(addr.error.message);
    const raw = c.req.query("luna") ?? "";
    if (!/^[1-9]\d{0,15}$/.test(raw)) return bad("luna must be a whole number above 0.");
    const row = await allowedSaver(addr.value, payer);
    const nothing = { address: addr.value, spendPercent: 0, price: raw, save: "0", total: raw, staker: null, reason: null };
    if (!row || row.spendPercent === 0) return c.json(nothing);
    try {
      const { grow } = await growState(row.address);
      const q = spendSave(BigInt(raw), row.spendPercent, grow);
      return c.json({
        address: row.address, spendPercent: row.spendPercent, price: q.price.toString(), save: q.save.toString(), total: q.total.toString(),
        staker: q.save > 0n ? row.address : null, reason: q.reason,
      });
    } catch (e) {
      log("save spend quote failed", { error: String(e) });
      return bad("Couldn't reach the Nimiq network. Try again in a minute.", 502);
    }
  });

  /** An app reports what it sent. Each transaction is checked on-chain before it shows in the user's history. */
  app.post("/v1/save/receipts", async (c) => {
    const payer = await payerFrom(c.req.header("authorization"));
    if (payer instanceof Response) return payer;
    const body = (await c.req.json().catch(() => null)) as { code?: unknown; address?: unknown; source?: unknown; payoutId?: unknown; walletTx?: unknown; growTx?: unknown } | null;
    if ((typeof body?.code === "string") === (typeof body?.address === "string")) return bad("Send either a save code or an address.");
    const source = body?.source === undefined || body.source === "payout" ? "payout" : body.source === "spend" ? "spend" : null;
    if (!source) return bad("source is \"payout\" or \"spend\".");
    const payoutId = typeof body?.payoutId === "string" && /^[\w:.-]{1,100}$/.test(body.payoutId) ? body.payoutId : "";
    if (!payoutId) return bad("payoutId is required: letters, digits and _ : . - only.");
    const txs = (["walletTx", "growTx"] as const)
      .map((k) => ({ k, hash: body?.[k] }))
      .filter((t): t is { k: "walletTx" | "growTx"; hash: string } => typeof t.hash === "string");
    if (txs.length === 0 || txs.some((t) => !/^[0-9a-f]{64}$/.test(t.hash))) return bad("Send walletTx and/or growTx as 64-character hex hashes.");
    let row: SaveCodeRow | undefined;
    if (typeof body?.address === "string") {
      const addr = parseNimiqAddress(body.address);
      if (!addr.ok) return bad(addr.error.message);
      // The same answer for "doesn't save with Droplets" and "didn't allow your app".
      row = await allowedSaver(addr.value, payer);
      if (!row) return bad("This address hasn't allowed your app to save for it.", 404);
    } else {
      const code = parseSaveCode(body!.code as string);
      if (!code.ok) return bad(code.error.message);
      row = await s.store.activeCode(code.value);
      if (!row) return bad("No active save code like that.", 404);
    }

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
        if (!ok) return bad(kind === "wallet" ? "walletTx didn't pay this saver's address." : "growTx isn't an add-stake into this saver's Grow savings.");
        await s.store.addReceipt({
          txHash: tx.hash, code: row.code, address: row.address, appId: payer.id, kind, source, luna: tx.value.toString(), payoutId, blockNumber: tx.blockNumber,
          // When it happened on-chain, so it's counted in the period the payment was made.
          createdAt: tx.timestamp || now(),
        });
        out[t.k] = "recorded";
      }
    } catch (e) {
      log("save receipt failed", { error: String(e) });
      return bad("Couldn't reach the Nimiq network. Try again in a minute.", 502);
    }
    log("save receipt", { app: payer.id, code: row.code, source, ...out });
    return c.json(out);
  });

  // ---- Admin: the apps that save with Droplets, from the admin page or curl. Keys are shown once, and never listed.

  /** Add an app the team set up itself. It's approved straight away. */
  app.post("/v1/admin/save/apps", async (c) => {
    if (!h.admin(c.req.header("authorization"))) return bad("Not found.", 404);
    const form = readAppForm(await jsonObject(c), { partial: false, contactRequired: false });
    if (form instanceof Response) return form;
    const { name = "", url = null, contact = null, payoutAddresses = [] } = form;
    if (nameTaken(await s.store.listApps(), name)) return bad(`There's already an app called ${name}.`);
    const apiKey = newAppKey();
    const id = randomUUID();
    await s.store.addApp({ id, name, keyHash: sha256Hex(apiKey), payoutAddresses, createdAt: now(), url, contact });
    log("save app added", { id, name });
    return c.json({ id, name, apiKey });
  });

  /** Every app, waiting or approved, with its details and what it has done through Droplets. */
  app.get("/v1/admin/save/apps", async (c) => {
    if (!h.admin(c.req.header("authorization"))) return bad("Not found.", 404);
    const [apps, usage] = await Promise.all([s.store.listApps(), s.store.appUsage()]);
    return c.json({ apps: apps.map(({ keyHash: _k, ...a }) => ({ ...a, usage: usage.get(a.id) ?? NO_USAGE })) });
  });

  /** Change an app's name, link, contact or payout addresses. Only the fields sent change. */
  app.patch("/v1/admin/save/apps/:id", async (c) => {
    if (!h.admin(c.req.header("authorization"))) return bad("Not found.", 404);
    const id = c.req.param("id");
    const form = readAppForm(await jsonObject(c), { partial: true, contactRequired: false });
    if (form instanceof Response) return form;
    if (Object.keys(form).length === 0) return bad("Send at least one of name, url, contact or payoutAddresses.");
    const apps = await s.store.listApps();
    if (!apps.some((a) => a.id === id)) return bad("No app with that id.", 404);
    if (form.name !== undefined && nameTaken(apps, form.name, id)) return bad(`There's already an app called ${form.name}.`);
    await s.store.updateApp(id, form);
    log("save app changed", { id, fields: Object.keys(form) });
    const changed = (await s.store.listApps()).find((a) => a.id === id);
    if (!changed) return bad("No app with that id.", 404);
    const { keyHash: _k, ...shown } = changed;
    return c.json({ app: shown });
  });

  /** A new key for an app, shown once. The old key stops working at once. */
  app.post("/v1/admin/save/apps/:id/key", async (c) => {
    if (!h.admin(c.req.header("authorization"))) return bad("Not found.", 404);
    const apiKey = newAppKey();
    if (!(await s.store.setAppKey(c.req.param("id"), sha256Hex(apiKey)))) return bad("No app with that id.", 404);
    log("save app key replaced", { id: c.req.param("id") });
    return c.json({ apiKey });
  });

  /** Approve an app that signed up: its key starts working, and people can pick it. */
  app.post("/v1/admin/save/apps/:id/approve", async (c) => {
    if (!h.admin(c.req.header("authorization"))) return bad("Not found.", 404);
    if (!(await s.store.approveApp(c.req.param("id")))) return bad("No app with that id.", 404);
    log("save app approved", { id: c.req.param("id") });
    return c.json({ approved: true });
  });

  /** Remove an app, approved or not: its key stops working and it leaves the list. */
  app.delete("/v1/admin/save/apps/:id", async (c) => {
    if (!h.admin(c.req.header("authorization"))) return bad("Not found.", 404);
    if (!(await s.store.removeApp(c.req.param("id")))) return bad("No app with that id.", 404);
    log("save app removed", { id: c.req.param("id") });
    return c.json({ removed: true });
  });
}
