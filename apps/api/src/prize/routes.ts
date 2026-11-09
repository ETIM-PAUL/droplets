import type { Env as HonoEnv, Hono } from "hono";
import {
  dailyLows,
  MAX_TICKETS,
  nimiqAddressBytes,
  nimiqAddressFromPublicKey,
  HTLC_LIFETIME_DAYS,
  nimiqMessageHash,
  ownHistory,
  parseDrawMessage,
  parseNimiqAddress,
  pickWinner,
  previousWeek,
  prizeWeekAt,
  scoreWeek,
  stakeChanges,
  STAKING_CONTRACT,
  type NimiqBlock,
  type NimiqRpc,
  type PrizeRules,
  type PrizeWeek,
  type StakePoint,
} from "@railkit/core";
import { rateLimiter } from "../rate-limit";
import { verifyEd25519 } from "../save/routes";
import type { PrizeDrawEntry, PrizeDrawRow, PrizeStore } from "./store";

export interface PrizeDeps {
  store: PrizeStore;
  chain: Pick<NimiqRpc, "staker" | "transactionsByAddress" | "latestBlock" | "block" | "transaction">;
  rules: PrizeRules;
  /** The wallet prizes are paid from. Its key stays with the payout tool; the API only checks payments against it. */
  prizeAddress: string | null;
  /** Ed25519 check of Nimiq Pay's signature; node:crypto by default. */
  verifySignature?: (hash: Uint8Array, publicKeyHex: string, signatureHex: string) => boolean;
}

interface Helpers {
  bad: (message: string, status?: 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503) => Response;
  clientKey: (h: (n: string) => string | undefined) => string;
  admin: (authorization: string | undefined) => boolean;
  now: () => number;
  log: (msg: string, data?: Record<string, unknown>) => void;
}

/** Wait this long after the draw time, so the block that decides it is well settled. */
export const DRAW_SETTLE_MS = 2 * 60_000;
/** Read each entry's stake at least this often. Drops are read from the chain itself; these catch rises. */
export const CHECK_EVERY_MS = 6 * 3_600_000;
/** A person's history is read this far: an account with more transactions in a week can't be scored. */
const HISTORY_MAX = 500;
const MAX_CLOCK_SKEW_MS = 10 * 60_000;
const DEVICE = /^[0-9a-f]{64}$/;

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const maskAddress = (a: string) => `${a.slice(0, 4)} … ${a.slice(-4)}`;

/**
 * Everything known about one person's active stake during a week: our readings and their own staking transactions.
 * Nimiq Pay sends those from the HTLC that holds the user's balance, not from their address, so read all their accounts.
 */
async function stakePoints(p: PrizeDeps, address: string, week: PrizeWeek): Promise<StakePoint[] | "incomplete"> {
  const start = week.days[0]!.start;
  const [checks, h] = await Promise.all([
    p.store.checks(address, start),
    // HTLCs time out within 14 days, so looking from 15 days before the week finds any she staked from during it. Only
    // the week itself needs reading in full.
    ownHistory(address, (a, max) => p.chain.transactionsByAddress(a, max), { since: start - HTLC_LIFETIME_DAYS * 86_400_000, need: start, max: HISTORY_MAX }),
  ]);
  // A history cut short may be missing a withdrawal.
  if (!h.complete) return "incomplete";
  return [...checks.map((c) => ({ at: c.at, kind: "seen" as const, active: BigInt(c.activeLuna) })), ...stakeChanges(address, h.txs, [address, ...h.htlcs])];
}

/** Reads due entries' stakes from the chain. A read that fails is skipped, never recorded as 0. */
export async function checkStakes(p: PrizeDeps, now: number, log: Helpers["log"], limit = 50): Promise<number> {
  const due = await p.store.due(now - CHECK_EVERY_MS, limit);
  let done = 0;
  for (const e of due) {
    try {
      const staker = await p.chain.staker(e.address);
      await p.store.addCheck({ address: e.address, at: now, activeLuna: (staker?.active ?? 0n).toString() });
      done++;
    } catch (err) {
      log("prize check failed", { error: String(err) });
    }
  }
  // Five weeks is plenty: a week's scoring only needs readings from just before it began.
  await p.store.pruneChecks(now - 35 * 86_400_000);
  return done;
}

/** The first block made at or after `at`, or null while there isn't one yet. Blocks come about one a second. */
export async function firstBlockAtOrAfter(chain: PrizeDeps["chain"], at: number): Promise<NimiqBlock | null> {
  const latest = await chain.latestBlock();
  if (latest.timestamp < at) return null;
  let lo = Math.max(1, latest.number - Math.ceil((latest.timestamp - at) / 1_000) - 60);
  let loBlock = await chain.block(lo);
  while (loBlock.timestamp >= at && lo > 1) {
    lo = Math.max(1, lo - 3_600);
    loBlock = await chain.block(lo);
  }
  if (loBlock.timestamp >= at) return loBlock;
  // Here block(lo) is before `at` and block(hi) at or after it.
  let hi = latest.number;
  let hiBlock = latest;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await chain.block(mid);
    if (b.timestamp >= at) [hi, hiBlock] = [mid, b];
    else lo = mid;
  }
  return hiBlock;
}

/** The latest week whose draw time has passed (and settled). */
export function weekToDraw(now: number, utcOffsetMinutes: number): PrizeWeek {
  const current = prizeWeekAt(now, utcOffsetMinutes);
  return now >= current.drawAt + DRAW_SETTLE_MS ? current : previousWeek(current, utcOffsetMinutes);
}

/**
 * Runs the draw for the latest finished week, once. Everyone who joined before the draw time is scored from the
 * chain; the first block after the draw time picks the winning ticket. Returns the new draw, or null if there's
 * nothing to do yet. If anyone's stake can't be read, nothing is drawn and the next run tries again.
 */
export async function runDraw(p: PrizeDeps, now: number, log: Helpers["log"]): Promise<PrizeDrawRow | null> {
  const week = weekToDraw(now, p.rules.utcOffsetMinutes);
  if (now < week.drawAt + DRAW_SETTLE_MS || (await p.store.draw(week.week))) return null;
  const block = await firstBlockAtOrAfter(p.chain, week.drawAt);
  if (!block) return null;

  const scored: PrizeDrawEntry[] = [];
  for (const e of (await p.store.entries()).filter((x) => x.joinedAt < week.drawAt)) {
    const points = await stakePoints(p, e.address, week);
    if (points === "incomplete") {
      log("prize entry skipped: too many transactions to read the week", { address: maskAddress(e.address) });
      continue;
    }
    const s = scoreWeek(dailyLows(points, week.days), p.rules);
    if (s.tickets > 0) scored.push({ address: e.address, tickets: s.tickets, daysKept: s.daysKept, keptLuna: s.keptLuna.toString() });
  }
  const win = pickWinner(scored, block.hash);
  const row: PrizeDrawRow = {
    week: week.week, drawAt: week.drawAt, blockNumber: block.number, blockHash: block.hash, entries: scored, totalTickets: win?.totalTickets ?? 0,
    winningTicket: win?.ticket ?? null, winner: win?.address ?? null, prizeLuna: p.rules.prizeLuna.toString(), status: win ? "unpaid" : "no-entries",
    payout: null, payoutTx: null, paidAt: null, createdAt: now,
  };
  if (!(await p.store.addDraw(row))) return null;
  log("prize drawn", { week: row.week, entries: scored.length, tickets: row.totalTickets, block: block.number, winner: row.winner && maskAddress(row.winner) });
  return row;
}

const publicDraw = (d: PrizeDrawRow, address?: string) => ({
  week: d.week, drawAt: d.drawAt, blockNumber: d.blockNumber, blockHash: d.blockHash, entries: d.entries.length, totalTickets: d.totalTickets,
  winningTicket: d.winningTicket, winner: d.winner && maskAddress(d.winner), youWon: !!address && d.winner === address, prizeLuna: d.prizeLuna,
  paid: d.status === "paid", payoutTx: d.payoutTx,
});

/**
 * The weekly draw. People join with a message signed in Nimiq Pay; the API reads stakes from the chain and runs
 * the draw, but never holds a key: the prize wallet's key stays with the payout tool, which reports back here.
 */
export function mountPrizeRoutes<E extends HonoEnv>(app: Hono<E>, p: PrizeDeps, h: Helpers) {
  const { bad, now, log } = h;
  const verifySig = p.verifySignature ?? verifyEd25519;
  const joinLimit = rateLimiter(10, 60_000, now);
  const readLimit = rateLimiter(60, 60_000, now);
  const ip = (c: { req: { header(n: string): string | undefined } }) => h.clientKey((n) => c.req.header(n));
  const rules = {
    minLuna: p.rules.minLuna.toString(), daysNeeded: p.rules.daysNeeded, prizeLuna: p.rules.prizeLuna.toString(), maxTickets: MAX_TICKETS,
    utcOffsetMinutes: p.rules.utcOffsetMinutes, prizeAddress: p.prizeAddress,
  };

  /** Join or leave, with the message the person signed in Nimiq Pay. Joining also needs Nimiq Pay's identifier for the phone. */
  app.post("/v1/prize/join", async (c) => {
    if (!joinLimit(ip(c))) return bad("Too many tries in a short time. Wait a minute.", 429);
    const body = (await c.req.json().catch(() => null)) as { message?: unknown; publicKey?: unknown; signature?: unknown; device?: unknown } | null;
    const message = typeof body?.message === "string" ? body.message : "";
    const publicKey = typeof body?.publicKey === "string" ? body.publicKey.toLowerCase() : "";
    const signature = typeof body?.signature === "string" ? body.signature.toLowerCase() : "";
    const m = parseDrawMessage(message);
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
    if (!(await p.store.useNonce(m.value.nonce, now()))) return bad("That request was already used. Try again.");

    const address = m.value.address;
    if (m.value.action === "leave") {
      await p.store.leave(address);
      log("prize left", {});
      return c.json({ joined: false });
    }
    const device = typeof body?.device === "string" ? body.device.toLowerCase() : "";
    if (!DEVICE.test(device)) return bad("Droplets needs Nimiq Pay to recognise this phone. Update Nimiq Pay and try again.");
    const other = await p.store.entryByDevice(device);
    if (other && other.address !== address) return bad("This phone is already in the draw with another account. Leave the draw with that account first.", 409);
    const existing = await p.store.entry(address);
    await p.store.join({ address, device, joinedAt: existing?.joinedAt ?? now(), checkedAt: existing?.checkedAt ?? null });
    // Read the stake right away: that reading is where this person's record starts.
    try {
      const staker = await p.chain.staker(address);
      await p.store.addCheck({ address, at: now(), activeLuna: (staker?.active ?? 0n).toString() });
    } catch (e) {
      log("prize first check failed", { error: String(e) });
    }
    log("prize joined", { again: !!existing });
    return c.json({ joined: true });
  });

  /** This week for one person: each day kept or missed, their tickets so far, last week's draw and their wins. */
  app.get("/v1/prize/me", async (c) => {
    if (!readLimit(ip(c))) return bad("Too many requests. Wait a minute.", 429);
    const addr = parseNimiqAddress(c.req.query("address") ?? "");
    if (!addr.ok) return bad(addr.error.message);
    const address = addr.value;
    const t = now();
    const [entry, [last], wins] = await Promise.all([p.store.entry(address), p.store.draws(1), p.store.wins(address)]);
    let week = null;
    if (entry) {
      const w = prizeWeekAt(t, p.rules.utcOffsetMinutes);
      try {
        // Opening Droplets is a good moment for a fresh reading.
        const staker = await p.chain.staker(address);
        await p.store.addCheck({ address, at: t, activeLuna: (staker?.active ?? 0n).toString() });
        const points = await stakePoints(p, address, w);
        const past = w.days.filter((d) => d.start <= t);
        const lows = points === "incomplete" ? past.map(() => null) : dailyLows(points, past.map((d) => ({ start: d.start, end: Math.min(d.end, t) })));
        const score = scoreWeek(lows, p.rules);
        week = {
          week: w.week, drawAt: w.drawAt, daysKept: score.daysKept, keptLuna: score.keptLuna.toString(), tickets: score.tickets,
          days: w.days.map((d, i) => {
            const low = lows[i] ?? null;
            const status = d.start > t ? "ahead" : d.end > t ? "today" : low !== null && low >= p.rules.minLuna ? "kept" : "missed";
            return { day: d.day, status, lowLuna: low === null ? null : low.toString() };
          }),
          tooManyTransactions: points === "incomplete",
        };
      } catch (e) {
        log("prize me failed", { error: String(e) });
        return bad("Couldn't reach the Nimiq network. Try again in a minute.", 502);
      }
    }
    return c.json({
      rules,
      joined: !!entry,
      week,
      lastDraw: last ? publicDraw(last, address) : null,
      wins: wins.map((d) => ({ week: d.week, drawAt: d.drawAt, prizeLuna: d.prizeLuna, paid: d.status === "paid", payoutTx: d.payoutTx })),
    });
  });

  /** Recent draws, for anyone to see. Winners are shortened here; the payout itself is on-chain. */
  app.get("/v1/prize/draws", async (c) => {
    if (!readLimit(ip(c))) return bad("Too many requests. Wait a minute.", 429);
    return c.json({ rules, draws: (await p.store.draws(10)).map((d) => publicDraw(d)) });
  });

  // ---- Admin: the payout tool (pnpm pay-prizes) asks who to pay, keeps what it signed here, and reports the payment.

  app.get("/v1/admin/prize/unpaid", async (c) => {
    if (!h.admin(c.req.header("authorization"))) return bad("Not found.", 404);
    return c.json({ prizeAddress: p.prizeAddress, draws: (await p.store.unpaid()).map((d) => ({ week: d.week, winner: d.winner, prizeLuna: d.prizeLuna, payout: d.payout })) });
  });

  app.post("/v1/admin/prize/payout", async (c) => {
    if (!h.admin(c.req.header("authorization"))) return bad("Not found.", 404);
    const body = (await c.req.json().catch(() => null)) as { week?: unknown; payout?: unknown } | null;
    const week = typeof body?.week === "string" ? body.week : "";
    const payout = typeof body?.payout === "string" && body.payout.length <= 20_000 ? body.payout : "";
    const d = week ? await p.store.draw(week) : undefined;
    if (!d || d.status !== "unpaid" || !payout) return bad("No unpaid draw like that, or no payout record.");
    await p.store.setPayout(week, payout);
    return c.json({ saved: true });
  });

  /** The payout tool reports its transaction; it counts once it's on-chain, from the prize wallet, to the winner. */
  app.post("/v1/admin/prize/paid", async (c) => {
    if (!h.admin(c.req.header("authorization"))) return bad("Not found.", 404);
    if (!p.prizeAddress) return bad("Set PRIZE_ADDRESS on the API first, so it can check payouts.", 503);
    const body = (await c.req.json().catch(() => null)) as { week?: unknown; txHash?: unknown } | null;
    const week = typeof body?.week === "string" ? body.week : "";
    const txHash = typeof body?.txHash === "string" && /^[0-9a-f]{64}$/.test(body.txHash) ? body.txHash : "";
    const d = week ? await p.store.draw(week) : undefined;
    if (!d || !d.winner || !txHash) return bad("Send the week and the payout's 64-character transaction hash.");
    if (d.status === "paid") return c.json({ status: "paid", txHash: d.payoutTx });
    let tx;
    try {
      tx = await p.chain.transaction(txHash);
    } catch (e) {
      log("prize paid check failed", { error: String(e) });
      return bad("Couldn't reach the Nimiq network. Try again in a minute.", 502);
    }
    if (!tx) return c.json({ status: "pending" });
    const intoGrow = tx.to === STAKING_CONTRACT && tx.recipientData.startsWith(`06${hex(nimiqAddressBytes(d.winner))}`);
    if (tx.from !== p.prizeAddress || !tx.executionResult || tx.value !== BigInt(d.prizeLuna) || !(intoGrow || tx.to === d.winner)) {
      return bad("That transaction isn't this prize: it must come from the prize wallet and pay the winner the prize.", 403);
    }
    await p.store.markPaid(week, txHash, now());
    log("prize paid", { week, intoGrow });
    return c.json({ status: "paid", txHash });
  });
}
