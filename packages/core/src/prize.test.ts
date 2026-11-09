import { describe, expect, it } from "vitest";
import { nimiqAddressBytes } from "./nimiq-address";
import type { NimiqTransaction } from "./nimiq-rpc";
import {
  dailyLows,
  formatDrawMessage,
  MAX_TICKETS,
  parseDrawMessage,
  pickWinner,
  previousWeek,
  prizeWeek,
  prizeWeekAt,
  scoreWeek,
  stakeChanges,
  ticketsFor,
  type StakePoint,
} from "./prize";
import { STAKING_CONTRACT } from "./save";

const NIM = (n: number) => BigInt(n) * 100_000n;
const WAT = 60;
const RULES = { minLuna: NIM(1_000), daysNeeded: 5 };
const ME = "NQ23 4CTV GPEU C004 7USS EPFM RQ5C METQ EMDP";
const OTHER = "NQ26 0000 0000 02A5 YAK7 4QNF 9MH0 TE2B GVRU";
const hexOf = (address: string) => Array.from(nimiqAddressBytes(address), (b) => b.toString(16).padStart(2, "0")).join("");
// The week of Monday 9 November 2026, West Africa Time.
const WEEK = prizeWeek("2026-11-09", WAT)!;
const at = (day: number, hour: number) => WEEK.days[day]!.start + hour * 3_600_000;

describe("weekly draw: tickets", () => {
  it("gives one ticket at the minimum and one more for each 10 times as much, up to the cap", () => {
    expect(ticketsFor(NIM(999), NIM(1_000))).toBe(0);
    expect(ticketsFor(NIM(1_000), NIM(1_000))).toBe(1);
    expect(ticketsFor(NIM(9_999), NIM(1_000))).toBe(1);
    expect(ticketsFor(NIM(10_000), NIM(1_000))).toBe(2);
    expect(ticketsFor(NIM(100_000), NIM(1_000))).toBe(3);
    expect(ticketsFor(NIM(1_000_000), NIM(1_000))).toBe(4);
    expect(ticketsFor(NIM(50_000_000), NIM(1_000))).toBe(MAX_TICKETS);
  });
});

describe("weekly draw: weeks", () => {
  it("runs Monday to Sunday in the draw's time zone, with the draw at Sunday 23:59", () => {
    expect(WEEK.week).toBe("2026-11-09");
    expect(WEEK.days.map((d) => d.day)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
    expect(new Date(WEEK.days[0]!.start).toISOString()).toBe("2026-11-08T23:00:00.000Z");
    expect(new Date(WEEK.drawAt).toISOString()).toBe("2026-11-15T22:59:00.000Z");
    expect(WEEK.days[6]!.end).toBe(WEEK.drawAt);
  });

  it("finds the week of any moment, and the week before", () => {
    expect(prizeWeekAt(Date.parse("2026-11-08T23:00:00Z"), WAT).week).toBe("2026-11-09"); // Monday 00:00 in Lagos
    expect(prizeWeekAt(Date.parse("2026-11-08T22:59:59Z"), WAT).week).toBe("2026-11-02"); // still Sunday there
    expect(prizeWeekAt(Date.parse("2026-11-15T23:30:00Z"), 0).week).toBe("2026-11-09"); // Sunday in UTC
    expect(previousWeek(WEEK, WAT).week).toBe("2026-11-02");
  });

  it("only names weeks by their Monday", () => {
    expect(prizeWeek("2026-11-10", WAT)).toBeNull();
    expect(prizeWeek("not a date", WAT)).toBeNull();
  });
});

describe("weekly draw: what was kept each day", () => {
  const tx = (over: Partial<NimiqTransaction>): NimiqTransaction => ({
    hash: "aa".repeat(32), blockNumber: 1, from: ME, to: STAKING_CONTRACT, value: 0n, recipientData: "", senderData: "", executionResult: true,
    confirmations: 10, timestamp: at(0, 9), ...over,
  });

  it("reads opening Grow, the person's own add-stakes and new active amounts from their transactions", () => {
    const points = stakeChanges(ME, [
      tx({ recipientData: "0500", value: NIM(2_000), timestamp: 1 }),
      tx({ recipientData: `06${hexOf(ME)}`, value: NIM(300), timestamp: 2 }),
      tx({ recipientData: `08${(NIM(500)).toString(16).padStart(16, "0")}${"ab".repeat(80)}`, timestamp: 3 }),
      // Not changes to this person's active stake:
      tx({ recipientData: `06${hexOf(OTHER)}`, value: NIM(9_000), timestamp: 4 }),
      tx({ recipientData: "0500", value: NIM(9_000), executionResult: false, timestamp: 5 }),
      tx({ to: OTHER, value: NIM(9_000), timestamp: 6 }),
    ]);
    expect(points).toEqual([
      { at: 1, kind: "set", active: NIM(2_000) },
      { at: 2, kind: "added", luna: NIM(300) },
      { at: 3, kind: "set", active: NIM(500) },
    ]);
  });

  it("knows nothing before the first point, then carries the last known amount forward", () => {
    const lows = dailyLows([{ at: at(1, 10), kind: "seen", active: NIM(5_000) }], WEEK.days);
    expect(lows).toEqual([null, NIM(5_000), NIM(5_000), NIM(5_000), NIM(5_000), NIM(5_000), NIM(5_000)]);
  });

  it("takes the lowest moment of each day, so dipping for an hour loses the day", () => {
    const points: StakePoint[] = [
      { at: at(0, 8), kind: "seen", active: NIM(2_000) },
      { at: at(2, 10), kind: "set", active: NIM(500) }, // Wednesday: a withdrawal starts
      { at: at(2, 11), kind: "added", luna: NIM(1_500) }, // and an hour later it's back up
    ];
    expect(dailyLows(points, WEEK.days)).toEqual([NIM(2_000), NIM(2_000), NIM(500), NIM(2_000), NIM(2_000), NIM(2_000), NIM(2_000)]);
  });

  it("lets a later reading raise what's known, but never a day's low that already happened", () => {
    const points: StakePoint[] = [
      { at: at(0, 8), kind: "seen", active: NIM(800) },
      { at: at(0, 20), kind: "seen", active: NIM(1_800) }, // an app paid into Grow that afternoon
    ];
    expect(dailyLows(points, WEEK.days).slice(0, 2)).toEqual([NIM(800), NIM(1_800)]);
  });
});

describe("weekly draw: qualifying", () => {
  it("needs the minimum on 5 of the 7 days, and counts the tier at the amount kept on 5 days", () => {
    const lows = [NIM(15_000), NIM(12_000), NIM(11_000), NIM(10_500), NIM(10_000), NIM(900), NIM(200_000)];
    expect(scoreWeek(lows, RULES)).toEqual({ daysKept: 6, keptLuna: NIM(10_500), tickets: 2 });
    expect(scoreWeek([NIM(5_000), NIM(5_000), NIM(5_000), NIM(5_000), null, null, null], RULES)).toEqual({ daysKept: 4, keptLuna: 0n, tickets: 0 });
  });

  it("makes taking stake out and back in cost the days it was out", () => {
    // Monday 2,000 NIM; Tuesday a withdrawal takes it to 0; Wednesday at noon it's staked again.
    const once: StakePoint[] = [
      { at: at(0, 1), kind: "seen", active: NIM(2_000) },
      { at: at(1, 9), kind: "set", active: 0n },
      { at: at(2, 12), kind: "added", luna: NIM(2_000) },
    ];
    expect(scoreWeek(dailyLows(once, WEEK.days), RULES)).toMatchObject({ daysKept: 5, tickets: 1 });
    // Doing it again on Friday leaves only 4 days.
    const twice: StakePoint[] = [...once, { at: at(4, 9), kind: "set", active: 0n }, { at: at(5, 12), kind: "added", luna: NIM(2_000) }];
    expect(scoreWeek(dailyLows(twice, WEEK.days), RULES)).toMatchObject({ daysKept: 3, tickets: 0 });
  });
});

describe("weekly draw: picking the winner", () => {
  const h = (n: number) => n.toString(16).padStart(64, "0");
  const entries = [
    { address: "NQ03 CCCC", tickets: 1 },
    { address: "NQ01 AAAA", tickets: 1 },
    { address: "NQ02 BBBB", tickets: 2 },
    { address: "NQ04 DDDD", tickets: 0 },
  ];

  it("numbers tickets in address order and takes the block hash modulo the total", () => {
    expect(pickWinner(entries, h(0))).toEqual({ address: "NQ01 AAAA", ticket: 0, totalTickets: 4 });
    expect(pickWinner(entries, h(1))?.address).toBe("NQ02 BBBB");
    expect(pickWinner(entries, h(2))?.address).toBe("NQ02 BBBB");
    expect(pickWinner(entries, h(3))?.address).toBe("NQ03 CCCC");
    expect(pickWinner(entries, h(4))?.address).toBe("NQ01 AAAA");
  });

  it("gives the same answer whatever order the entries come in", () => {
    const hash = "9f".repeat(32);
    expect(pickWinner([...entries].reverse(), hash)).toEqual(pickWinner(entries, hash));
  });

  it("has no winner without tickets, and refuses a hash that isn't one", () => {
    expect(pickWinner([{ address: "NQ01 AAAA", tickets: 0 }], h(1))).toBeNull();
    expect(() => pickWinner(entries, "not a hash")).toThrow(RangeError);
  });
});

describe("weekly draw: signed messages", () => {
  const m = { action: "join" as const, address: ME, time: "2026-11-09T10:00:00.000Z", nonce: "0123456789abcdef" };

  it("reads back exactly what it writes", () => {
    const text = formatDrawMessage(m);
    expect(text).toBe(`Errand weekly draw\nAction: join\nAddress: ${ME}\nTime: 2026-11-09T10:00:00.000Z\nNonce: 0123456789abcdef`);
    expect(parseDrawMessage(text)).toEqual({ ok: true, value: m });
  });

  it("refuses anything that reads differently from what was signed", () => {
    expect(parseDrawMessage(formatDrawMessage(m).replace("join", "win")).ok).toBe(false);
    expect(parseDrawMessage(`${formatDrawMessage(m)}\nExtra: 1`).ok).toBe(false);
    expect(parseDrawMessage(formatDrawMessage(m).replace(ME, ME.toLowerCase())).ok).toBe(false);
  });
});
