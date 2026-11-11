import { describe, expect, it } from "vitest";
import { parseNimiqAddress } from "./nimiq-address";
import {
  BREAK_COOLDOWN_MS,
  BREAK_FEE_ADDRESS,
  breakFeeLuna,
  formatGoalMessage,
  goalBreaking,
  goalDone,
  goalLocked,
  isGoalName,
  parseGoalMessage,
  reconcileGoals,
  withdrawableLuna,
  type GoalInput,
  type GoalMessage,
} from "./goals";

const NIM = (n: number) => BigInt(n) * 100_000n;
const ADDRESS = "NQ23 4CTV GPEU C004 7USS EPFM RQ5C METQ EMDP";
const T = Date.UTC(2026, 10, 10, 9); // Tuesday 10 November 2026, 09:00 UTC

const goal = (over: Partial<GoalInput> = {}): GoalInput => ({
  id: "g1", order: 0, targetLuna: null, dueAt: null, allocatedLuna: 0n, breakRequestedAt: null, breachedAt: null, ...over,
});

describe("the signed goal message", () => {
  const create: GoalMessage = { action: "create", address: ADDRESS, name: "School fees", targetLuna: NIM(50_000), dueAt: Date.UTC(2027, 2, 1), time: "2026-11-04T15:20:00.000Z", nonce: "9f2c4d1e8a7b6c5d" };

  it("round-trips create, with and without a target or a date", () => {
    const text = formatGoalMessage(create);
    expect(text).toBe(`Droplets goal\nAction: create\nAddress: ${ADDRESS}\nName: School fees\nTarget: 50000\nDue: 2027-03-01\nTime: 2026-11-04T15:20:00.000Z\nNonce: 9f2c4d1e8a7b6c5d`);
    expect(parseGoalMessage(text)).toEqual({ ok: true, value: create });
    const open = { ...create, targetLuna: null, dueAt: null };
    expect(parseGoalMessage(formatGoalMessage(open))).toEqual({ ok: true, value: open });
  });

  it("round-trips edit, delete, break and reorder", () => {
    const edit: GoalMessage = { ...create, action: "edit", goalId: "g1", name: "School fees 2027" };
    expect(parseGoalMessage(formatGoalMessage(edit))).toEqual({ ok: true, value: edit });
    const del: GoalMessage = { action: "delete", address: ADDRESS, goalId: "g1", time: create.time, nonce: create.nonce };
    expect(formatGoalMessage(del)).toBe(`Droplets goal\nAction: delete\nAddress: ${ADDRESS}\nGoal: g1\nTime: 2026-11-04T15:20:00.000Z\nNonce: 9f2c4d1e8a7b6c5d`);
    expect(parseGoalMessage(formatGoalMessage(del))).toEqual({ ok: true, value: del });
    const brk: GoalMessage = { ...del, action: "break" };
    expect(parseGoalMessage(formatGoalMessage(brk))).toEqual({ ok: true, value: brk });
    const reorder: GoalMessage = { action: "reorder", address: ADDRESS, order: ["g2", "g1", "g3"], time: create.time, nonce: create.nonce };
    expect(formatGoalMessage(reorder)).toBe(`Droplets goal\nAction: reorder\nAddress: ${ADDRESS}\nOrder: g2,g1,g3\nTime: 2026-11-04T15:20:00.000Z\nNonce: 9f2c4d1e8a7b6c5d`);
    expect(parseGoalMessage(formatGoalMessage(reorder))).toEqual({ ok: true, value: reorder });
  });

  it("refuses anything that reads differently from what formatGoalMessage writes, or breaks the rules", () => {
    const text = formatGoalMessage(create);
    for (const bad of [
      text.replace("Name: School fees", "Name: "),
      text.replace("Target: 50000", "Target: 0"),
      text.replace("Target: 50000", "Target: -5"),
      text.replace("Due: 2027-03-01", "Due: 1 March 2027"),
      text.replace(ADDRESS, ADDRESS.toLowerCase()),
      text.replace("Nonce: 9f2c4d1e8a7b6c5d", "Nonce: short"),
      text + "\nExtra: line",
      text.replace("Droplets goal", "Droplets Goal"),
      text.replace("Action: create", "Action: destroy"),
    ]) {
      expect(parseGoalMessage(bad).ok, bad).toBe(false);
    }
    // A name with a newline could forge extra lines in the signed message: refused up front.
    expect(isGoalName("two\nlines")).toBe(false);
    expect(isGoalName(" leading space")).toBe(false);
    expect(isGoalName("x".repeat(61))).toBe(false);
    expect(isGoalName("")).toBe(false);
    expect(isGoalName("Trip to Lagos")).toBe(true);
    // Reordering the same goal twice, or naming none, is refused.
    expect(parseGoalMessage(formatGoalMessage({ action: "reorder", address: ADDRESS, order: ["g1", "g1"], time: create.time, nonce: create.nonce })).ok).toBe(false);
    expect(parseGoalMessage(formatGoalMessage({ action: "reorder", address: ADDRESS, order: [], time: create.time, nonce: create.nonce })).ok).toBe(false);
  });
});

describe("locked, breaking and done", () => {
  it("locks only a goal with a future date, until the date, or a completed break", () => {
    const dated = goal({ dueAt: T + 10 * 86_400_000 });
    expect(goalLocked(dated, T)).toBe(true);
    expect(goalLocked(goal({ dueAt: null }), T)).toBe(false);
    expect(goalLocked(goal({ dueAt: T - 1 }), T)).toBe(false); // due date already passed
    const breaking = { ...dated, breakRequestedAt: T };
    expect(goalLocked(breaking, T + BREAK_COOLDOWN_MS - 1)).toBe(true);
    expect(goalBreaking(breaking, T + BREAK_COOLDOWN_MS - 1)).toBe(true);
    expect(goalLocked(breaking, T + BREAK_COOLDOWN_MS)).toBe(false);
    expect(goalBreaking(breaking, T + BREAK_COOLDOWN_MS)).toBe(false);
    expect(goalLocked({ ...dated, breachedAt: T }, T)).toBe(false);
  });

  it("is done once allocated reaches the target; a goal with no target never is", () => {
    expect(goalDone(goal({ targetLuna: NIM(100), allocatedLuna: NIM(100) }))).toBe(true);
    expect(goalDone(goal({ targetLuna: NIM(100), allocatedLuna: NIM(99) }))).toBe(false);
    expect(goalDone(goal({ targetLuna: null, allocatedLuna: NIM(999_999) }))).toBe(false);
  });
});

describe("what's free to withdraw", () => {
  it("is the total less whatever sits in a locked goal", () => {
    const goals = [goal({ id: "a", dueAt: T + 86_400_000, allocatedLuna: NIM(1_000) }), goal({ id: "b", dueAt: null, allocatedLuna: NIM(500) })];
    expect(withdrawableLuna(goals, NIM(2_000), T)).toBe(NIM(1_000));
  });

  it("never goes negative, even if a locked goal's share exceeds the current total", () => {
    const goals = [goal({ id: "a", dueAt: T + 86_400_000, allocatedLuna: NIM(1_000) })];
    expect(withdrawableLuna(goals, NIM(500), T)).toBe(0n);
  });
});

describe("filling goals from growth, and draining them on a withdrawal", () => {
  it("fills the first goal to its target, then the next, in order", () => {
    const goals = [goal({ id: "a", order: 0, targetLuna: NIM(1_000) }), goal({ id: "b", order: 1, targetLuna: NIM(2_000) }), goal({ id: "c", order: 2, targetLuna: null })];
    const r = reconcileGoals(goals, NIM(2_500), T);
    expect(r.changes).toEqual(new Map([["a", NIM(1_000)], ["b", NIM(1_500)]]));
    expect(r.breached.size).toBe(0);
  });

  it("skips a goal that's already done, and the open-ended last goal absorbs everything past the others", () => {
    const goals = [goal({ id: "a", order: 0, targetLuna: NIM(1_000), allocatedLuna: NIM(1_000) }), goal({ id: "b", order: 1, targetLuna: null, allocatedLuna: NIM(50) })];
    const r = reconcileGoals(goals, NIM(400), T);
    expect(r.changes).toEqual(new Map([["b", NIM(450)]]));
  });

  it("sends targeted growth to the named goal first, then waterfalls whatever's left over the rest in order", () => {
    const goals = [goal({ id: "a", order: 0, targetLuna: NIM(1_000) }), goal({ id: "b", order: 1, targetLuna: NIM(200) })];
    const r = reconcileGoals(goals, NIM(300), T, { goalId: "b", luna: NIM(200) });
    expect(r.changes).toEqual(new Map([["b", NIM(200)], ["a", NIM(100)]]));
  });

  it("caps a targeted credit at the goal's remaining room, and at the growth actually seen", () => {
    const goals = [goal({ id: "a", order: 0, targetLuna: NIM(100), allocatedLuna: NIM(80) })];
    // Asked to credit 500 to "a", but only 50 of growth happened, and "a" only has room for 20 more: fine either way.
    const r = reconcileGoals(goals, NIM(50), T, { goalId: "a", luna: NIM(500) });
    expect(r.changes).toEqual(new Map([["a", NIM(100)]])); // capped by the goal's own target, not by the 50 seen
  });

  it("drains last goal first on a withdrawal, protecting earlier goals", () => {
    const goals = [goal({ id: "a", order: 0, allocatedLuna: NIM(1_000) }), goal({ id: "b", order: 1, allocatedLuna: NIM(500) })];
    const r = reconcileGoals(goals, -NIM(200), T);
    expect(r.changes).toEqual(new Map([["b", NIM(300)]]));
    expect(r.breached.size).toBe(0);
  });

  it("flags a locked goal as breached only once draining reaches it, meaning it happened outside Droplets", () => {
    const goals = [
      goal({ id: "a", order: 0, dueAt: T + 86_400_000, allocatedLuna: NIM(1_000) }),
      goal({ id: "b", order: 1, allocatedLuna: NIM(300) }),
    ];
    // A withdrawal of 200: drains only "b" (unlocked), "a" untouched and not breached.
    const small = reconcileGoals(goals, -NIM(200), T);
    expect(small.changes).toEqual(new Map([["b", NIM(100)]]));
    expect(small.breached.size).toBe(0);
    // A withdrawal of 1,200: drains all of "b" (300) then reaches into locked "a" for 900: that's a breach.
    const big = reconcileGoals(goals, -NIM(1_200), T);
    expect(big.changes).toEqual(new Map([["b", 0n], ["a", NIM(100)]]));
    expect(big.breached).toEqual(new Set(["a"]));
  });

  it("does nothing for a zero delta", () => {
    const goals = [goal({ id: "a", allocatedLuna: NIM(10) })];
    const r = reconcileGoals(goals, 0n, T);
    expect(r.changes.size).toBe(0);
    expect(r.breached.size).toBe(0);
  });
});

describe("the cost of breaking a goal early", () => {
  it("is a well-formed Nimiq address", () => {
    expect(parseNimiqAddress(BREAK_FEE_ADDRESS)).toEqual({ ok: true, value: BREAK_FEE_ADDRESS });
  });

  it("is 10% of what's currently in the goal, floored", () => {
    expect(breakFeeLuna(NIM(500))).toBe(NIM(50));
    expect(breakFeeLuna(101n)).toBe(10n); // floor(10.1)
    expect(breakFeeLuna(0n)).toBe(0n);
  });
});
