// Goals: named slices of one person's own savings (their one Nimiq stake), with an optional target and an optional
// date. Drops (payouts, saving when you pay, catch-ups, and the person's own top-ups) fill the first goal that
// isn't full yet, then the next, in the order the person set. A goal with a date can't be withdrawn from Droplets
// until that date, or until the person deliberately breaks it and waits out a cooling-off. Droplets never holds the
// money: a goal is bookkeeping over the one stake, kept honest by reading the chain, never a separate account.
import { parseNimiqAddress } from "./nimiq-address";
import { fail, ok, type Result } from "./result";
import { lunaToNimString, nimStringToLuna } from "./save";

// ---- The signed message. One per change, so only the owner can create, edit, reorder, delete or break a goal.

export type GoalAction = "create" | "edit" | "reorder" | "delete" | "break";

export interface GoalMessage {
  action: GoalAction;
  address: string;
  /** The goal it's about. Absent only for "create", where the goal doesn't exist yet, and "reorder". */
  goalId?: string;
  /** Only for "create" and "edit". */
  name?: string;
  /** Luna; null for no target. Only for "create" and "edit". */
  targetLuna?: bigint | null;
  /** Midnight UTC on that date; null for no date. Only for "create" and "edit". */
  dueAt?: number | null;
  /** Every one of the person's goals, in the new fill order. Only for "reorder". */
  order?: string[];
  /** ISO 8601 UTC, e.g. 2026-11-04T15:20:00.000Z. */
  time: string;
  /** 16 to 64 hex characters, never reused. */
  nonce: string;
}

const MESSAGE_TITLE = "Droplets goal";
/** A goal's name: up to 60 characters, no control characters (a newline would let it forge extra message lines). */
export const isGoalName = (name: string): boolean => name.length > 0 && name.length <= 60 && name === name.trim() && !/[\x00-\x1f\x7f]/.test(name);
/** Most goals one person can have at once. */
export const MAX_GOALS = 20;
const DATE_ONLY = /^\d{4}-\d\d-\d\d$/;

/** A calendar date, as written in a signed message, to midnight UTC that day. */
function dateToMs(s: string): number | null {
  if (!DATE_ONLY.test(s)) return null;
  const ms = Date.parse(`${s}T00:00:00.000Z`);
  return Number.isNaN(ms) ? null : ms;
}
const msToDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The exact text the user signs. One field per line, so what Nimiq Pay shows is what we check. */
export function formatGoalMessage(m: GoalMessage): string {
  const lines = [MESSAGE_TITLE, `Action: ${m.action}`, `Address: ${m.address}`];
  if (m.action !== "create" && m.action !== "reorder") lines.push(`Goal: ${m.goalId}`);
  if (m.action === "create" || m.action === "edit") {
    lines.push(`Name: ${m.name}`, `Target: ${m.targetLuna == null ? "none" : lunaToNimString(m.targetLuna)}`, `Due: ${m.dueAt == null ? "none" : msToDate(m.dueAt)}`);
  }
  if (m.action === "reorder") lines.push(`Order: ${m.order!.join(",")}`);
  lines.push(`Time: ${m.time}`, `Nonce: ${m.nonce}`);
  return lines.join("\n");
}

/** Reads a signed goal message. Anything but the exact format formatGoalMessage writes is refused. */
export function parseGoalMessage(text: string): Result<GoalMessage> {
  const bad = fail("unrecognised", "That isn't a Droplets goal message.");
  const lines = text.split("\n");
  if (lines[0] !== MESSAGE_TITLE) return bad;
  const field = (i: number, name: string) => (lines[i]?.startsWith(`${name}: `) ? lines[i]!.slice(name.length + 2) : null);
  const action = field(1, "Action") as GoalAction | null;
  if (!action || !["create", "edit", "reorder", "delete", "break"].includes(action)) return bad;
  const address = parseNimiqAddress(field(2, "Address") ?? "");
  if (!address.ok) return bad;
  let i = 3;
  let goalId: string | undefined;
  if (action !== "create" && action !== "reorder") {
    goalId = field(i++, "Goal") ?? undefined;
    if (!goalId) return bad;
  }
  let name: string | undefined;
  let targetLuna: bigint | null | undefined;
  let dueAt: number | null | undefined;
  if (action === "create" || action === "edit") {
    name = field(i++, "Name") ?? undefined;
    if (!name || !isGoalName(name)) return fail("unrecognised", "Give the goal a name of up to 60 characters.");
    const targetText = field(i++, "Target");
    if (targetText === null) return bad;
    if (targetText === "none") targetLuna = null;
    else {
      const t = nimStringToLuna(targetText);
      if (!t.ok || t.value <= 0n) return fail("bad_amount", "The target must be a whole or decimal amount in NIM, above 0.");
      targetLuna = t.value;
    }
    const dueText = field(i++, "Due");
    if (dueText === null) return bad;
    if (dueText === "none") dueAt = null;
    else {
      const d = dateToMs(dueText);
      if (d === null) return fail("bad_amount", "The date must be a calendar date.");
      dueAt = d;
    }
  }
  let order: string[] | undefined;
  if (action === "reorder") {
    const list = field(i++, "Order");
    if (!list) return bad;
    order = list.split(",");
    if (order.length === 0 || order.length > MAX_GOALS || new Set(order).size !== order.length) return bad;
  }
  const time = field(i++, "Time") ?? "";
  const nonce = field(i++, "Nonce") ?? "";
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/.test(time) || Number.isNaN(Date.parse(time))) return bad;
  if (!/^[0-9a-f]{16,64}$/.test(nonce) || lines.length !== i) return bad;
  const m: GoalMessage = { action, address: address.value, ...(goalId ? { goalId } : {}), ...(name ? { name, targetLuna, dueAt } : {}), ...(order ? { order } : {}), time, nonce };
  // Round trip: refuses extra spaces, a lowercase address or anything else that reads differently from what was signed.
  return formatGoalMessage(m) === text ? ok(m) : bad;
}

// ---- Filling goals from savings, and what's locked.

/** How long after breaking a dated goal its money is still locked, so breaking one is a deliberate wait, not a tap. */
export const BREAK_COOLDOWN_MS = 24 * 3_600_000;
/** How long Droplets refuses a new goal after an address withdraws from a locked goal outside Droplets. */
export const GOAL_BAN_MS = 7 * 24 * 3_600_000;
/** The share of a goal's current savings that breaking it early costs, paid to Droplets. */
export const BREAK_FEE_PERCENT = 10;
/** Where a broken goal's fee goes. A fixed address, not configurable: it's Droplets' own, not a user's. */
export const BREAK_FEE_ADDRESS = "NQ30 KFJH 33KR DV21 2UP6 X74P R2YB 0M50 ALYT";

/** The luna owed to break a goal early: a whole-number percent of what's currently in it, floored like a payout's share. */
export const breakFeeLuna = (allocatedLuna: bigint): bigint => (allocatedLuna * BigInt(BREAK_FEE_PERCENT)) / 100n;

export interface GoalInput {
  id: string;
  /** Fill order: lower first. */
  order: number;
  /** Luna; null for no target, meaning it absorbs every drop that reaches it and is never "done". */
  targetLuna: bigint | null;
  /** Midnight UTC on that date; null for no date, meaning it's never locked. */
  dueAt: number | null;
  /** How much of the one stake is currently earmarked for this goal. */
  allocatedLuna: bigint;
  /** When the person asked to break this goal's lock early; null if they haven't. */
  breakRequestedAt: number | null;
  /** When an external withdrawal (outside Droplets) was found to have eaten into this goal while it was locked. */
  breachedAt: number | null;
}

/** Whether a goal's money can't be withdrawn from Droplets right now. */
export function goalLocked(g: Pick<GoalInput, "dueAt" | "breakRequestedAt" | "breachedAt">, now: number): boolean {
  if (g.breachedAt !== null) return false; // already lost the protection it was meant to have
  if (g.dueAt === null || g.dueAt <= now) return false;
  if (g.breakRequestedAt !== null && now >= g.breakRequestedAt + BREAK_COOLDOWN_MS) return false;
  return true;
}

/** Whether a break was asked for and its cooling-off hasn't finished yet. */
export function goalBreaking(g: Pick<GoalInput, "dueAt" | "breakRequestedAt">, now: number): boolean {
  return g.dueAt !== null && g.dueAt > now && g.breakRequestedAt !== null && now < g.breakRequestedAt + BREAK_COOLDOWN_MS;
}

/** Whether a goal has reached its target. A goal with no target is never done. */
export const goalDone = (g: Pick<GoalInput, "targetLuna" | "allocatedLuna">): boolean => g.targetLuna !== null && g.allocatedLuna >= g.targetLuna;

/** What's free to withdraw right now: the whole stake, less whatever sits in a currently locked goal. Never negative. */
export function withdrawableLuna(goals: GoalInput[], totalLuna: bigint, now: number): bigint {
  const locked = goals.filter((g) => goalLocked(g, now)).reduce((a, g) => a + g.allocatedLuna, 0n);
  const free = totalLuna - locked;
  return free < 0n ? 0n : free > totalLuna ? totalLuna : free;
}

export interface GoalReconcileResult {
  /** New allocatedLuna for each goal that changed. */
  changes: Map<string, bigint>;
  /** Goals a shrinking total reached into while they were locked: a withdrawal made outside Droplets. */
  breached: Set<string>;
}

/**
 * Moves `delta` (growth or shrinkage in the stake's total since it was last read) across the goals. Growth fills
 * goals in order, each up to its target, with any goal that has no target taking the rest; `targeted` sends growth
 * to one goal first, before the order takes over for whatever's left. Shrinkage drains in the opposite order, last
 * goal first, so a locked goal only loses money once every later goal and all free savings are already gone — which
 * can only happen through a withdrawal made outside Droplets, since Droplets itself never offers more than
 * `withdrawableLuna` to take out.
 */
export function reconcileGoals(goalsIn: GoalInput[], delta: bigint, now: number, targeted?: { goalId: string; luna: bigint }): GoalReconcileResult {
  const goals = [...goalsIn].sort((a, b) => a.order - b.order).map((g) => ({ ...g }));
  const changes = new Map<string, bigint>();
  const breached = new Set<string>();
  const set = (g: GoalInput, v: bigint) => {
    if (v !== g.allocatedLuna) changes.set(g.id, v);
    g.allocatedLuna = v;
  };

  let left = delta > 0n ? delta : 0n;
  if (targeted && left > 0n) {
    const g = goals.find((x) => x.id === targeted.goalId);
    if (g && !goalDone(g)) {
      const room = g.targetLuna === null ? left : g.targetLuna - g.allocatedLuna;
      const want = targeted.luna < left ? targeted.luna : left;
      const amount = room < want ? room : want;
      set(g, g.allocatedLuna + amount);
      left -= amount;
    }
  }
  if (left > 0n) {
    for (const g of goals) {
      if (left <= 0n) break;
      if (goalDone(g)) continue;
      const room = g.targetLuna === null ? left : g.targetLuna - g.allocatedLuna;
      const add = room < left ? room : left;
      set(g, g.allocatedLuna + add);
      left -= add;
    }
  }
  if (delta < 0n) {
    let owed = -delta;
    for (const g of [...goals].reverse()) {
      if (owed <= 0n) break;
      const take = g.allocatedLuna < owed ? g.allocatedLuna : owed;
      if (take === 0n) continue;
      const wasLocked = goalLocked(g, now);
      set(g, g.allocatedLuna - take);
      owed -= take;
      if (wasLocked) breached.add(g.id);
    }
  }
  return { changes, breached };
}
