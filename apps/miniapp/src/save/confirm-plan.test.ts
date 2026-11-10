import type { SaveMe } from "@railkit/client";
import { describe, expect, it } from "vitest";
import { canConfirm, plan } from "./confirm-plan";

const NIM = (n: number) => String(n * 100_000);
const saver = (over: Partial<SaveMe> = {}): SaveMe => ({
  network: "testnet", address: "NQ25 P6YX JM69 LKAS K2DC EX64 H2V4 0FBY 4MSX", code: "SAVE-YEFMH3Q", savePercent: 30, spendPercent: 5, catchUp: "weekly",
  apps: [], blockNumber: 1, growClosed: null, receipts: [], splits: [],
  grow: { active: NIM(500), inactive: "0", inactiveFrom: null, retired: "0", delegation: "NQ26 0000 0000 02A5 YAK7 4QNF 9MH0 TE2B GVRU", releaseBlock: null, validatorJailed: false },
  ...over,
});
const notOpen = { grow: null, growClosed: "no-stake" as const };

describe("which chat requests get a Confirm button", () => {
  it("only complete ones", () => {
    expect(canConfirm({ action: "rule", savePercent: 30 })).toBe(true);
    expect(canConfirm({ action: "add", nim: "500" })).toBe(true);
    expect(canConfirm({ action: "withdraw", all: true })).toBe(true);
    expect(canConfirm({ action: "withdraw", nim: "50" })).toBe(true);
    expect(canConfirm({ action: "revoke" })).toBe(true);
    for (const s of [{ action: "rule" as const }, { action: "add" as const }, { action: "withdraw" as const }, { action: "show" as const }, { action: "ask" as const }]) {
      expect(canConfirm(s), s.action).toBe(false);
    }
  });
});

describe("what Confirm will do", () => {
  it("changes the share of payouts, and gives a first code when savings are open", () => {
    expect(plan({ action: "rule", savePercent: 50 }, saver())).toMatchObject({ kind: "rule", savePercent: 50, title: "Save 50% of what apps pay you", detail: expect.stringMatching(/Now 30%/) });
    expect(plan({ action: "rule", savePercent: 20 }, saver({ code: null, savePercent: null }))).toMatchObject({ kind: "rule", detail: expect.stringMatching(/save code/) });
    expect(plan({ action: "rule", savePercent: 20 }, saver({ code: null, savePercent: null, ...notOpen })).kind).toBe("form");
    expect(plan({ action: "rule", savePercent: 101 }, saver()).kind).toBe("form");
    expect(plan({ action: "rule", savePercent: 9 }, saver()).kind).toBe("form");
    expect(plan({ action: "rule", savePercent: 10 }, saver()).kind).toBe("rule");
  });

  it("adds to open savings, and sends anything else to the form", () => {
    expect(plan({ action: "add", nim: "250.5" }, saver())).toMatchObject({ kind: "add", luna: 25_050_000n, title: "Add 250.50 NIM to your savings" });
    expect(plan({ action: "add", nim: "500" }, saver(notOpen))).toMatchObject({ kind: "form", why: expect.stringMatching(/aren't open/) });
    expect(plan({ action: "add", nim: "lots" }, saver()).kind).toBe("form");
    expect(plan({ action: "add", nim: "0" }, saver()).kind).toBe("form");
  });

  it("withdraws what the rules allow: all of it, or leaving at least 100 NIM", () => {
    expect(plan({ action: "withdraw", all: true }, saver())).toMatchObject({ kind: "withdraw", luna: 50_000_000n, newActive: 0n });
    expect(plan({ action: "withdraw", nim: "100" }, saver())).toMatchObject({ kind: "withdraw", luna: 10_000_000n, newActive: 40_000_000n });
    expect(plan({ action: "withdraw", nim: "450" }, saver())).toMatchObject({ kind: "form", why: expect.stringMatching(/at least 100 NIM/) });
    expect(plan({ action: "withdraw", nim: "900" }, saver())).toMatchObject({ kind: "form", why: expect.stringMatching(/more than you have/) });
    expect(plan({ action: "withdraw", all: true }, saver(notOpen)).kind).toBe("form");
  });

  it("turns off a code that exists", () => {
    expect(plan({ action: "revoke" }, saver())).toMatchObject({ kind: "revoke", title: expect.stringMatching(/SAVE-YEFMH3Q/) });
    expect(plan({ action: "revoke" }, saver({ code: null })).kind).toBe("form");
  });
});
