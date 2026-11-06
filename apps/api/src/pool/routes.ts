import {
  formatPrice,
  formatUsd,
  lunaToNimString,
  lunaToUsd,
  newPoolOrderId,
  nimiqAddressFromPublicKey,
  nimiqMessageHash,
  nimStringToLuna,
  parseNimiqAddress,
  parsePoolWithdrawMessage,
  poolDepositMemo,
  poolPosition,
  poolTotals,
  type NimiqRpc,
  type PoolSide,
} from "@railkit/core";
import { latestState, nextSettlementAt, poolReserves, type PoolConfig, type PoolStore } from "@railkit/pool";
import type { Env as HonoEnv, Hono } from "hono";
import { rateLimiter } from "../rate-limit";
import { verifyEd25519 } from "../save/routes";

export interface PoolDeps {
  store: PoolStore;
  rpc: Pick<NimiqRpc, "balance">;
  cfg: PoolConfig;
  /** The smallest deposit, in luna. */
  minDepositLuna?: bigint;
  verifySignature?: (hash: Uint8Array, publicKeyHex: string, signatureHex: string) => boolean;
}

interface Helpers {
  bad: (message: string, status?: 400 | 401 | 403 | 404 | 429 | 502 | 503) => Response;
  clientKey: (h: (n: string) => string | undefined) => string;
  admin: (authorization: string | undefined) => boolean;
  now: () => number;
  log: (msg: string, data?: Record<string, unknown>) => void;
}

const MAX_CLOCK_SKEW_MS = 10 * 60_000;
const nim = (luna: bigint) => lunaToNimString(luna);

/**
 * Steady and Boost: the two-sided pool. The API only takes orders and shows the books; it holds no keys.
 * Deposits are paid by the user in Nimiq Pay with the order's memo; the pool worker settles once a day and pays out.
 */
export function mountPoolRoutes<E extends HonoEnv>(app: Hono<E>, p: PoolDeps, h: Helpers) {
  const { bad, now, log } = h;
  const verifySig = p.verifySignature ?? verifyEd25519;
  const readLimit = rateLimiter(120, 60_000, now);
  const writeLimit = rateLimiter(20, 60_000, now);
  const ip = (c: { req: { header(n: string): string | undefined } }) => h.clientKey((n) => c.req.header(n));
  const paused = async () => (await p.store.getSetting("paused")) === "true";

  app.get("/v1/pool/state", async (c) => {
    if (!readLimit(ip(c))) return bad("Too many requests. Wait a minute.", 429);
    const s = await latestState(p.store);
    const t = s.price > 0n ? poolTotals(s, s.price) : null;
    return c.json({
      network: p.cfg.network,
      poolAddress: p.cfg.poolAddress,
      paused: await paused(),
      settlement: t && {
        seq: s.seq,
        at: s.at,
        priceUsd: formatPrice(s.price),
        coverBps: t.coverBps,
        steadyUsd: formatUsd(t.steadyUsd),
        boostNim: nim(t.boostLuna),
        boostLeveragePct: t.boostLuna > 0n ? Number(((t.boostLuna + t.claimLuna) * 100n) / t.boostLuna) : null,
      },
      nextSettlementAt: nextSettlementAt(now(), p.cfg),
      feeBpsPerYear: p.cfg.feeBpsPerYear,
      caps: {
        steadyUsdPerAddress: p.cfg.caps.maxSteadyUsdPerAddress !== undefined ? formatUsd(p.cfg.caps.maxSteadyUsdPerAddress) : null,
        steadyUsdTotal: p.cfg.caps.maxSteadyUsdTotal !== undefined ? formatUsd(p.cfg.caps.maxSteadyUsdTotal) : null,
        boostNimPerAddress: p.cfg.caps.maxBoostLunaPerAddress !== undefined ? nim(p.cfg.caps.maxBoostLunaPerAddress) : null,
      },
    });
  });

  app.get("/v1/pool/me", async (c) => {
    if (!readLimit(ip(c))) return bad("Too many requests. Wait a minute.", 429);
    const addr = parseNimiqAddress(c.req.query("address") ?? "");
    if (!addr.ok) return bad(addr.error.message);
    const [s, orders, payouts] = await Promise.all([latestState(p.store), p.store.ordersForAddress(addr.value, 30), p.store.payoutsForAddress(addr.value, 30)]);
    const pos = poolPosition(s, addr.value, s.price);
    return c.json({
      steady: { usd: formatUsd(pos.steadyUsd), nimAtLastPrice: nim(pos.steadyLuna) },
      boost: { nim: nim(pos.boostLuna), leveragePct: pos.boostLeveragePct },
      orders: orders.map((o) => ({
        id: o.id, side: o.side, kind: o.kind, status: o.status, note: o.note, createdAt: o.createdAt, txHash: o.txHash,
        nim: o.kind === "deposit" ? nim(BigInt(o.luna ?? o.expectedLuna ?? "0")) : o.side === "boost" && o.amount !== null ? nim(BigInt(o.amount)) : null,
        usd: o.kind === "withdraw" && o.side === "steady" && o.amount !== null ? formatUsd(BigInt(o.amount)) : null,
        all: o.kind === "withdraw" && o.amount === null,
      })),
      payouts: payouts.map((x) => ({ id: x.id, orderId: x.orderId, nim: nim(BigInt(x.luna)), reason: x.reason, status: x.status, txHash: x.txHash })),
    });
  });

  /** A deposit order. The user then pays it in Nimiq Pay, to the pool, with the memo. Nothing is taken until then. */
  app.post("/v1/pool/deposits", async (c) => {
    if (!writeLimit(ip(c))) return bad("Too many requests in a short time. Wait a minute.", 429);
    if (await paused()) return bad("Steady and Boost are paused right now. Try again later.", 503);
    const body = (await c.req.json().catch(() => null)) as { address?: unknown; side?: unknown; nim?: unknown } | null;
    const addr = parseNimiqAddress(typeof body?.address === "string" ? body.address : "");
    if (!addr.ok) return bad(addr.error.message);
    const side = body?.side === "steady" || body?.side === "boost" ? (body.side as PoolSide) : null;
    if (!side) return bad("Choose Steady or Boost.");
    const luna = nimStringToLuna(typeof body?.nim === "string" ? body.nim : "");
    if (!luna.ok) return bad(luna.error.message);
    if (luna.value < (p.minDepositLuna ?? 100_000n)) return bad(`The smallest deposit is ${nim(p.minDepositLuna ?? 100_000n)} NIM.`);

    // An early warning against the pilot's caps, at the last price. The settlement checks again and refunds if needed.
    const s = await latestState(p.store);
    if (s.price > 0n) {
      const pos = poolPosition(s, addr.value, s.price);
      const steadyCap = p.cfg.caps.maxSteadyUsdPerAddress;
      if (side === "steady" && steadyCap !== undefined && pos.steadyUsd + lunaToUsd(luna.value, s.price) > steadyCap) return bad(`That would take your Steady over the pilot's limit of $${formatUsd(steadyCap)}.`);
      const boostCap = p.cfg.caps.maxBoostLunaPerAddress;
      if (side === "boost" && boostCap !== undefined && pos.boostLuna + luna.value > boostCap) return bad(`That would take your Boost over the pilot's limit of ${nim(boostCap)} NIM.`);
    }

    const id = newPoolOrderId();
    await p.store.addOrder({
      id, address: addr.value, side, kind: "deposit", expectedLuna: luna.value.toString(), luna: null, amount: null, status: "awaiting_payment",
      txHash: null, note: null, createdAt: now(), expiresAt: now() + p.cfg.depositTtlMs, queuedAt: null, settledSeq: null,
    });
    log("pool deposit order", { id, side });
    return c.json({ orderId: id, poolAddress: p.cfg.poolAddress, memo: poolDepositMemo(side, id), nim: nim(luna.value), luna: luna.value.toString(), settlesAt: nextSettlementAt(now(), p.cfg) });
  });

  /** A withdrawal, signed in Nimiq Pay so only the owner can ask. It's paid out after the next settlement. */
  app.post("/v1/pool/withdrawals", async (c) => {
    if (!writeLimit(ip(c))) return bad("Too many requests in a short time. Wait a minute.", 429);
    const body = (await c.req.json().catch(() => null)) as { message?: unknown; publicKey?: unknown; signature?: unknown } | null;
    const message = typeof body?.message === "string" ? body.message : "";
    const publicKey = typeof body?.publicKey === "string" ? body.publicKey.toLowerCase() : "";
    const signature = typeof body?.signature === "string" ? body.signature.toLowerCase() : "";
    const m = parsePoolWithdrawMessage(message);
    if (!m.ok) return bad(m.error.message);
    if (Math.abs(now() - Date.parse(m.value.time)) > MAX_CLOCK_SKEW_MS) return bad("That request is too old. Try again.");
    let signer: string;
    try {
      signer = nimiqAddressFromPublicKey(publicKey);
    } catch {
      return bad("Nimiq Pay's signature is missing. Try again.");
    }
    if (signer !== m.value.address) return bad("That was signed by a different Nimiq account.", 403);
    if (!verifySig(nimiqMessageHash(message), publicKey, signature)) return bad("Nimiq Pay's signature didn't check out. Try again.", 403);
    if (!(await p.store.useNonce(m.value.nonce, now()))) return bad("That request was already used. Try again.");

    const s = await latestState(p.store);
    const pos = poolPosition(s, m.value.address, s.price);
    if ((m.value.side === "steady" ? pos.steadyUsd : pos.boostShares) === 0n) return bad(`You don't have anything in ${m.value.side === "steady" ? "Steady" : "Boost"} to withdraw.`);
    const id = newPoolOrderId();
    await p.store.addOrder({
      id, address: m.value.address, side: m.value.side, kind: "withdraw", expectedLuna: null, luna: null, amount: m.value.amountUnits === null ? null : m.value.amountUnits.toString(),
      status: "queued", txHash: null, note: null, createdAt: now(), expiresAt: null, queuedAt: now(), settledSeq: null,
    });
    log("pool withdrawal order", { id, side: m.value.side });
    return c.json({ orderId: id, settlesAt: nextSettlementAt(now(), p.cfg) });
  });

  /** Proof of reserves: the pool's NIM on-chain against everything it owes. */
  app.get("/v1/pool/reserves", async (c) => {
    if (!readLimit(ip(c))) return bad("Too many requests. Wait a minute.", 429);
    try {
      const r = await poolReserves({ store: p.store, rpc: p.rpc, cfg: p.cfg });
      return c.json({
        poolAddress: r.poolAddress,
        onChainNim: nim(r.onChainLuna),
        owedNim: nim(r.owedLuna),
        covered: r.surplusLuna >= 0n,
        surplusNim: r.surplusLuna >= 0n ? nim(r.surplusLuna) : `-${nim(-r.surplusLuna)}`,
        breakdown: Object.fromEntries(Object.entries(r.breakdown).map(([k, v]) => [k.replace(/Luna$/, "Nim"), nim(v)])),
        lastSettlement: r.lastSettlement,
      });
    } catch (e) {
      log("pool reserves failed", { error: String(e) });
      return bad("Couldn't reach the Nimiq network. Try again in a minute.", 502);
    }
  });

  app.post("/v1/admin/pool/pause", async (c) => {
    if (!h.admin(c.req.header("authorization"))) return bad("Not found.", 404);
    const body = (await c.req.json().catch(() => null)) as { paused?: unknown } | null;
    if (typeof body?.paused !== "boolean") return bad("Send {\"paused\": true} or false.");
    await p.store.setSetting("paused", String(body.paused));
    log("pool pause set", { paused: body.paused });
    return c.json({ paused: body.paused });
  });

  app.get("/v1/admin/pool/unmatched", async (c) => {
    if (!h.admin(c.req.header("authorization"))) return bad("Not found.", 404);
    return c.json({ unmatched: await p.store.listUnmatched() });
  });
}
