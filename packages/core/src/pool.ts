// Errand Save, feature 2: the two-sided pool. Steady balances are kept in dollars; Boost holds shares of
// whatever NIM is left once Steady is covered, so it takes NIM's price moves for both sides.
// Pure integer maths: NIM in luna, dollars in micro-dollars, the price as USD per NIM × 10^12.
import { parseNimiqAddress } from "./nimiq-address";
import { fail, ok, type Result } from "./result";

export const PRICE_SCALE = 10n ** 12n;
export const USD_SCALE = 10n ** 6n;
const LUNA_PER_NIM = 100_000n;
/** luna × price / CONVERT = micro-dollars. */
const CONVERT = (LUNA_PER_NIM * PRICE_SCALE) / USD_SCALE;

export const lunaToUsd = (luna: bigint, price: bigint): bigint => (luna * price) / CONVERT;
export const usdToLuna = (usd: bigint, price: bigint): bigint => (usd * CONVERT) / price;

export type PoolSide = "steady" | "boost";

/** The pool's books after a settlement. Balances only change at settlements. */
export interface PoolState {
  /** Settlement number; 0 before the first one. */
  seq: number;
  at: number;
  /** The settlement price, USD per NIM × 10^12. 0 before the first settlement. */
  price: bigint;
  /** NIM owed to Steady and Boost together. Fees and payouts already decided are not in it. */
  poolLuna: bigint;
  /** Fees collected: ours to take out. */
  feeLuna: bigint;
  /** Address → micro-dollars. */
  steady: Record<string, bigint>;
  /** Address → Boost shares. */
  boost: Record<string, bigint>;
  boostShares: bigint;
  /** Orders this settlement applied, so a crash halfway through can be repaired without applying them twice. */
  appliedOrders: string[];
}

export const GENESIS: PoolState = { seq: 0, at: 0, price: 0n, poolLuna: 0n, feeLuna: 0n, steady: {}, boost: {}, boostShares: 0n, appliedOrders: [] };

export type PoolOrder =
  | { id: string; kind: "deposit"; side: PoolSide; address: string; luna: bigint; at: number }
  /** amount: micro-dollars for Steady, luna for Boost; null means everything. */
  | { id: string; kind: "withdraw"; side: PoolSide; address: string; amount: bigint | null; at: number };

export type OrderResult =
  | { id: string; status: "filled"; usd?: bigint; shares?: bigint; luna: bigint }
  /** A deposit the pool couldn't take: its NIM goes back to the sender. */
  | { id: string; status: "refunded"; luna: bigint; reason: string }
  /** A Boost withdrawal that would leave Steady without cover: it stays queued for the next settlement. */
  | { id: string; status: "waiting"; reason: string }
  | { id: string; status: "rejected"; reason: string };

export interface PoolPayout {
  /** `${seq}:${orderId}`, so a repeated settlement never pays twice. */
  id: string;
  orderId: string;
  address: string;
  luna: bigint;
  reason: "withdrawal" | "refund";
}

export interface SettleConfig {
  /** For example 100 = 1% a year, taken a little at each settlement. */
  feeBpsPerYear: number;
  /** 365 for daily settlements. */
  settlementsPerYear: number;
  /** Caps, in micro-dollars. A deposit that would go over is refunded. */
  maxSteadyUsdPerAddress?: bigint;
  maxSteadyUsdTotal?: bigint;
  maxBoostLunaPerAddress?: bigint;
}

export interface PoolTotals {
  /** NIM Steady is owed at the price. */
  claimLuna: bigint;
  /** NIM left for Boost. */
  boostLuna: bigint;
  /** Boost NIM ÷ Steady's claim, in basis points (10,000 = fully covered); null with no Steady. */
  coverBps: number | null;
  steadyUsd: bigint;
}

const add = (m: Record<string, bigint>, k: string, v: bigint) => {
  const n = (m[k] ?? 0n) + v;
  if (n === 0n) delete m[k];
  else m[k] = n;
};
const total = (m: Record<string, bigint>) => Object.values(m).reduce((a, b) => a + b, 0n);

export function poolTotals(s: Pick<PoolState, "poolLuna" | "steady">, price: bigint): PoolTotals {
  const steadyUsd = total(s.steady);
  const claim = price > 0n ? usdToLuna(steadyUsd, price) : 0n;
  const claimLuna = claim > s.poolLuna ? s.poolLuna : claim;
  const boostLuna = s.poolLuna - claimLuna;
  return { claimLuna, boostLuna, coverBps: claim === 0n ? null : Number((boostLuna * 10_000n) / claim), steadyUsd };
}

/** What one address holds, valued at a price (the last settlement's, or a live one for an estimate). */
export function poolPosition(s: PoolState, address: string, price: bigint) {
  const t = poolTotals(s, price);
  const usd = s.steady[address] ?? 0n;
  const shares = s.boost[address] ?? 0n;
  return {
    steadyUsd: usd,
    steadyLuna: price > 0n ? usdToLuna(usd, price) : 0n,
    boostShares: shares,
    boostLuna: s.boostShares > 0n ? (shares * t.boostLuna) / s.boostShares : 0n,
    /** How much of NIM's move Boost takes: (Boost NIM + Steady's claim) ÷ Boost NIM, × 100. */
    boostLeveragePct: t.boostLuna > 0n ? Number(((t.boostLuna + t.claimLuna) * 100n) / t.boostLuna) : null,
  };
}

/**
 * One settlement at `price`. Steady keeps its dollar value; Boost absorbs the move. If NIM fell so far that
 * Steady is owed more than the pool holds, Steady shares the whole pool and Boost is wiped out.
 * Then the fee, then the queued orders at this same price: withdrawals first, then Boost deposits, then
 * Steady deposits, which are only taken while Boost still covers all of Steady.
 */
export function settle(prev: PoolState, orders: PoolOrder[], price: bigint, at: number, cfg: SettleConfig) {
  if (price <= 0n) throw new RangeError("price must be above 0");
  const seq = prev.seq + 1;
  const s: PoolState = { ...prev, seq, at, price, steady: { ...prev.steady }, boost: { ...prev.boost }, appliedOrders: [] };
  const results: OrderResult[] = [];
  const payouts: PoolPayout[] = [];
  const pay = (o: PoolOrder, luna: bigint, reason: PoolPayout["reason"]) => payouts.push({ id: `${seq}:${o.id}`, orderId: o.id, address: o.address, luna, reason });

  // 1. The price move. Only a crash beyond cover changes anyone's balance: Steady shares the pool, Boost is wiped out.
  let wipedOut = false;
  const steadyUsd = total(s.steady);
  if (steadyUsd > 0n && usdToLuna(steadyUsd, price) > s.poolLuna) {
    wipedOut = true;
    const worth = lunaToUsd(s.poolLuna, price);
    for (const k of Object.keys(s.steady)) {
      const v = (s.steady[k]! * worth) / steadyUsd;
      if (v === 0n) delete s.steady[k];
      else s.steady[k] = v;
    }
    s.boost = {};
    s.boostShares = 0n;
  }
  if (s.boostShares === 0n) {
    // Rounding dust with no Boost left to own it goes to fees rather than to the next Boost deposit.
    const dust = poolTotals(s, price).boostLuna;
    s.poolLuna -= dust;
    s.feeLuna += dust;
  }

  // 2. The fee, a little at each settlement, from both sides.
  const per = BigInt(10_000 * cfg.settlementsPerYear);
  const fee = BigInt(cfg.feeBpsPerYear);
  let steadyFeeUsd = 0n;
  for (const k of Object.keys(s.steady)) {
    const f = (s.steady[k]! * fee) / per;
    steadyFeeUsd += f;
    add(s.steady, k, -f);
  }
  const steadyFeeLuna = usdToLuna(steadyFeeUsd, price);
  const boostFeeLuna = (poolTotals({ poolLuna: s.poolLuna - steadyFeeLuna, steady: s.steady }, price).boostLuna * fee) / per;
  const feeLuna = steadyFeeLuna + boostFeeLuna;
  s.poolLuna -= feeLuna;
  s.feeLuna += feeLuna;

  // 3. Orders, oldest first within each step.
  const sorted = [...orders].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const step = (kind: PoolOrder["kind"], side: PoolSide) => sorted.filter((o) => o.kind === kind && o.side === side);

  for (const o of step("withdraw", "steady")) {
    const held = s.steady[o.address] ?? 0n;
    const usd = o.kind === "withdraw" && o.amount !== null && o.amount < held ? o.amount : held;
    const luna = usdToLuna(usd, price);
    if (held === 0n || luna === 0n) {
      results.push({ id: o.id, status: "rejected", reason: held === 0n ? "Nothing in Steady to withdraw." : "That's too little to withdraw." });
      continue;
    }
    add(s.steady, o.address, -usd);
    s.poolLuna -= luna;
    pay(o, luna, "withdrawal");
    results.push({ id: o.id, status: "filled", usd, luna });
  }

  for (const o of step("withdraw", "boost")) {
    const held = s.boost[o.address] ?? 0n;
    const t = poolTotals(s, price);
    if (held === 0n || s.boostShares === 0n || t.boostLuna === 0n) {
      results.push({ id: o.id, status: "rejected", reason: "Nothing in Boost to withdraw." });
      continue;
    }
    const want = o.kind === "withdraw" ? o.amount : null;
    let shares = want === null ? held : (want * s.boostShares) / t.boostLuna;
    if (shares > held) shares = held;
    const luna = (shares * t.boostLuna) / s.boostShares;
    if (shares === 0n || luna === 0n) {
      results.push({ id: o.id, status: "rejected", reason: "That's too little to withdraw." });
      continue;
    }
    if (t.claimLuna > 0n && t.boostLuna - luna < t.claimLuna) {
      results.push({ id: o.id, status: "waiting", reason: "Savers in Steady need this cover. It pays out once more Boost comes in or Steady shrinks." });
      continue;
    }
    add(s.boost, o.address, -shares);
    s.boostShares -= shares;
    s.poolLuna -= luna;
    pay(o, luna, "withdrawal");
    results.push({ id: o.id, status: "filled", shares, luna });
  }

  for (const o of step("deposit", "boost")) {
    const luna = o.kind === "deposit" ? o.luna : 0n;
    const t = poolTotals(s, price);
    const mine = s.boostShares > 0n ? ((s.boost[o.address] ?? 0n) * t.boostLuna) / s.boostShares : 0n;
    if (cfg.maxBoostLunaPerAddress !== undefined && mine + luna > cfg.maxBoostLunaPerAddress) {
      pay(o, luna, "refund");
      results.push({ id: o.id, status: "refunded", luna, reason: "That would take your Boost over the pilot's limit." });
      continue;
    }
    if (s.boostShares > 0n && t.boostLuna === 0n) {
      // Old shares are worth nothing: they mustn't share in a new deposit.
      s.boost = {};
      s.boostShares = 0n;
    }
    const shares = s.boostShares === 0n ? luna : (luna * s.boostShares) / t.boostLuna;
    add(s.boost, o.address, shares);
    s.boostShares += shares;
    s.poolLuna += luna;
    results.push({ id: o.id, status: "filled", shares, luna });
  }

  for (const o of step("deposit", "steady")) {
    const luna = o.kind === "deposit" ? o.luna : 0n;
    const usd = lunaToUsd(luna, price);
    const t = poolTotals(s, price);
    const refund = (reason: string) => {
      pay(o, luna, "refund");
      results.push({ id: o.id, status: "refunded", luna, reason });
    };
    if (usd === 0n) refund("That's too little to save.");
    else if (cfg.maxSteadyUsdPerAddress !== undefined && (s.steady[o.address] ?? 0n) + usd > cfg.maxSteadyUsdPerAddress) refund("That would take your Steady over the pilot's limit.");
    else if (cfg.maxSteadyUsdTotal !== undefined && t.steadyUsd + usd > cfg.maxSteadyUsdTotal) refund("Steady is full for the pilot right now.");
    else if (t.boostLuna < t.claimLuna + usdToLuna(usd, price)) refund("There isn't enough Boost to cover more Steady right now.");
    else {
      add(s.steady, o.address, usd);
      s.poolLuna += luna;
      results.push({ id: o.id, status: "filled", usd, luna });
    }
  }

  s.appliedOrders = results.filter((r) => r.status !== "waiting").map((r) => r.id);
  return { state: s, results, payouts, totals: poolTotals(s, price), feeLuna, wipedOut };
}

// ---- Storage: bigint as strings.

export function poolStateToJson(s: PoolState): string {
  const strs = (m: Record<string, bigint>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.toString()]));
  return JSON.stringify({ ...s, price: s.price.toString(), poolLuna: s.poolLuna.toString(), feeLuna: s.feeLuna.toString(), boostShares: s.boostShares.toString(), steady: strs(s.steady), boost: strs(s.boost) });
}

export function poolStateFromJson(json: string): PoolState {
  const j = JSON.parse(json) as Record<string, unknown>;
  const big = (m: unknown) => Object.fromEntries(Object.entries(m as Record<string, string>).map(([k, v]) => [k, BigInt(v)]));
  return {
    seq: Number(j.seq), at: Number(j.at), price: BigInt(j.price as string), poolLuna: BigInt(j.poolLuna as string), feeLuna: BigInt(j.feeLuna as string),
    steady: big(j.steady), boost: big(j.boost), boostShares: BigInt(j.boostShares as string), appliedOrders: (j.appliedOrders as string[]) ?? [],
  };
}

/** "0.0003016254871891327" (USD per NIM) → the price scale. */
export function parsePrice(usdPerNim: string | number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(usdPerNim).trim());
  if (!m) throw new RangeError(`Not a price: ${usdPerNim}`);
  return BigInt(m[1]!) * PRICE_SCALE + BigInt((m[2] ?? "").padEnd(12, "0").slice(0, 12));
}

/** Micro-dollars as "12.34", rounded down to cents. */
export const formatUsd = (usd: bigint): string => `${usd / USD_SCALE}.${((usd % USD_SCALE) / 10_000n).toString().padStart(2, "0")}`;

/** "12.34" or "12" dollars → micro-dollars. */
export function parseUsd(text: string): bigint | null {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text.trim().replace(/^\$/, ""));
  return m ? BigInt(m[1]!) * USD_SCALE + BigInt((m[2] ?? "").padEnd(2, "0")) * 10_000n : null;
}

// ---- The settlement price: the median of several sources, or no settlement at all.

export interface PriceSource {
  name: string;
  price: bigint;
}

/**
 * Picks the settlement price. Needs at least two sources; pauses (no settlement) when they disagree by more
 * than `maxSpreadBps` or the median moved more than `maxMoveBps` since the last settlement. A paused
 * settlement only means the next one waits; nobody's balance changes.
 */
export function choosePrice(sources: PriceSource[], lastPrice: bigint, cfg = { maxSpreadBps: 500, maxMoveBps: 5_000 }): { ok: true; price: bigint } | { ok: false; reason: string } {
  const prices = sources.map((x) => x.price).filter((p) => p > 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (prices.length < 2) return { ok: false, reason: `Only ${prices.length} price source answered; settlement needs at least 2.` };
  const mid = prices.length >> 1;
  const median = prices.length % 2 ? prices[mid]! : (prices[mid - 1]! + prices[mid]!) / 2n;
  const spread = ((prices.at(-1)! - prices[0]!) * 10_000n) / median;
  if (spread > BigInt(cfg.maxSpreadBps)) return { ok: false, reason: `Price sources disagree by ${Number(spread) / 100}%.` };
  if (lastPrice > 0n) {
    const move = ((median > lastPrice ? median - lastPrice : lastPrice - median) * 10_000n) / lastPrice;
    if (move > BigInt(cfg.maxMoveBps)) return { ok: false, reason: `The price moved ${Number(move) / 100}% since the last settlement; check it before settling.` };
  }
  return { ok: true, price: median };
}

// ---- Withdrawals are requested with a message signed in Nimiq Pay, like the save rule.

export interface PoolWithdrawMessage {
  address: string;
  side: PoolSide;
  /** Dollars ("12.50") for Steady, NIM ("1000.5") for Boost, or "all". */
  amount: string;
  time: string;
  nonce: string;
}

const POOL_TITLE = "Errand pool";

export function formatPoolWithdrawMessage(m: PoolWithdrawMessage): string {
  return [POOL_TITLE, "Action: withdraw", `Address: ${m.address}`, `Side: ${m.side}`, `Amount: ${m.amount}`, `Time: ${m.time}`, `Nonce: ${m.nonce}`].join("\n");
}

/** Reads a signed withdrawal. Only the exact text formatPoolWithdrawMessage writes is accepted. */
export function parsePoolWithdrawMessage(text: string): Result<PoolWithdrawMessage & { amountUnits: bigint | null }> {
  const bad = fail("unrecognised", "That isn't an Errand pool request.");
  const l = text.split("\n");
  if (l.length !== 7 || l[0] !== POOL_TITLE || l[1] !== "Action: withdraw") return bad;
  const v = (i: number, k: string) => (l[i]?.startsWith(`${k}: `) ? l[i]!.slice(k.length + 2) : "");
  const address = parseNimiqAddress(v(2, "Address"));
  const side = v(3, "Side");
  const amount = v(4, "Amount");
  const time = v(5, "Time");
  const nonce = v(6, "Nonce");
  if (!address.ok || (side !== "steady" && side !== "boost")) return bad;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/.test(time) || Number.isNaN(Date.parse(time)) || !/^[0-9a-f]{16,64}$/.test(nonce)) return bad;
  let amountUnits: bigint | null = null;
  if (amount !== "all") {
    if (side === "steady") amountUnits = parseUsd(amount);
    else {
      const m = /^(\d{1,12})(?:\.(\d{1,5}))?$/.exec(amount);
      amountUnits = m ? BigInt(m[1]!) * LUNA_PER_NIM + BigInt((m[2] ?? "").padEnd(5, "0")) : null;
    }
    if (amountUnits === null || amountUnits <= 0n) return fail("bad_amount", side === "steady" ? "Enter dollars with up to 2 decimals, or all." : "Enter NIM with up to 5 decimals, or all.");
  }
  const m: PoolWithdrawMessage = { address: address.value, side, amount, time, nonce };
  return formatPoolWithdrawMessage(m) === text ? ok({ ...m, amountUnits }) : bad;
}

/** The memo on a deposit: "Errand Steady 7KQ2XMP9AB". Shown in Nimiq Pay's dialog, matched by the pool's watcher. */
export const poolDepositMemo = (side: PoolSide, orderId: string) => `Errand ${side === "steady" ? "Steady" : "Boost"} ${orderId}`;
export function readPoolDepositMemo(memo: string): { side: PoolSide; orderId: string } | null {
  const m = /^Errand (Steady|Boost) ([0-9A-HJKMNP-TV-Z]{10})$/.exec(memo);
  return m ? { side: m[1] === "Steady" ? "steady" : "boost", orderId: m[2]! } : null;
}

/** A random 10-character order id in Crockford base32 (no I, L, O or U), as used in deposit memos. */
export function newPoolOrderId(random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return [...random(10)].map((b) => alphabet[b & 31]).join("");
}

/** The price scale back to a decimal string of USD per NIM, e.g. "0.000301". */
export function formatPrice(price: bigint): string {
  const frac = (price % PRICE_SCALE).toString().padStart(12, "0").replace(/0+$/, "");
  return frac ? `${price / PRICE_SCALE}.${frac}` : `${price / PRICE_SCALE}`;
}
