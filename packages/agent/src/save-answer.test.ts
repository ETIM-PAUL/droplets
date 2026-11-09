import { describe, expect, it, vi } from "vitest";
import { answerSavingsQuestion, looksEnglish, periodBounds, phraseSavingsAnswer, phrasingKeepsFacts, type SavingsFacts } from "./save-answer";

const NIM = (n: number) => BigInt(n) * 100_000n;
const NOW = Date.UTC(2026, 10, 4, 12, 0); // 4 Nov 2026, 12:00 UTC
const BASE: SavingsFacts = {
  code: "SAVE-7KQ2XMP",
  savePercent: 30,
  grow: { active: NIM(500), inactive: 0n, retired: 0n, releaseBlock: null, validatorJailed: false },
  growClosed: null,
  blockNumber: 66_000_000,
  receipts: [],
  splits: [],
};
const facts = (over: Partial<SavingsFacts>): SavingsFacts => ({ ...BASE, ...over });
const ask = (question: Parameters<typeof answerSavingsQuestion>[0]["question"], f: SavingsFacts = BASE, period?: "today" | "week" | "month" | "last-month") =>
  answerSavingsQuestion({ question, period }, f, { now: NOW, tzOffsetMinutes: 60 }).text;

describe("answers worked out from the user's own data", () => {
  it("balance", () => {
    expect(ask("balance")).toBe("You have 500 NIM in savings, all of it earning staking rewards.");
    expect(ask("balance", facts({ grow: { active: NIM(300), inactive: NIM(150), retired: NIM(50), releaseBlock: 1, validatorJailed: false } }))).toBe(
      "You have 500 NIM in savings: 300 NIM earning, 150 NIM on its way out, 50 NIM ready to move to your wallet.",
    );
    expect(ask("balance", facts({ grow: null, growClosed: "no-stake" }))).toMatch(/haven't opened your savings yet/);
    expect(ask("balance", facts({ grow: null, growClosed: "validator-gone" }))).toMatch(/validator you staked with shut down/);
  });

  it("how much came in over a period, in the user's own time zone", () => {
    const receipts = [
      { app: "Arcade", kind: "grow" as const, luna: NIM(600), at: Date.UTC(2026, 10, 3) },
      { app: "Arcade", kind: "wallet" as const, luna: NIM(1400), at: Date.UTC(2026, 10, 3) },
      { app: "Bounty Board", kind: "grow" as const, luna: 15_050_000n, at: Date.UTC(2026, 10, 1, 2) },
      { app: "Arcade", kind: "grow" as const, luna: NIM(99), at: Date.UTC(2026, 9, 20) },
    ];
    expect(ask("period", facts({ receipts }), "month")).toBe("This month, apps paid 750.5 NIM into your savings, in 2 payments. Another 1,400 NIM went to your wallet.");
    expect(ask("period", facts({ receipts }), "last-month")).toBe("Last month, apps paid 99 NIM into your savings, in 1 payment.");
    expect(ask("period", facts({ receipts }), "today")).toBe("Today, no app paid into your savings.");
  });

  it("when withdrawn money is ready", () => {
    const g = (over: Partial<NonNullable<SavingsFacts["grow"]>>) => facts({ grow: { active: NIM(300), inactive: 0n, retired: 0n, releaseBlock: null, validatorJailed: false, ...over } });
    expect(ask("release", g({}))).toMatch(/haven't started a withdrawal/);
    expect(ask("release", g({ inactive: NIM(200), releaseBlock: 66_000_000 + 14 * 3600 }))).toBe("200 NIM is ready in about 14 hours. Then open Savings and tap Finish withdrawal.");
    expect(ask("release", g({ inactive: NIM(200), releaseBlock: 65_999_000 }))).toMatch(/^200 NIM is ready now/);
    expect(ask("release", g({ retired: NIM(200) }))).toMatch(/^200 NIM is ready now/);
    expect(ask("release", g({ inactive: NIM(200), releaseBlock: 66_000_000 + 600, validatorJailed: true }))).toMatch(/about 10 minutes.*up to 4 days/);
    expect(ask("release", facts({ grow: null, growClosed: "no-stake" }))).toBe("You don't have anything in savings to withdraw.");
  });

  it("why a payment went to the wallet", () => {
    const split = (over: Partial<SavingsFacts["splits"][number]>) => ({ app: "Arcade", walletLuna: NIM(2000), growLuna: 0n, reason: null, savePercent: 30, at: Date.UTC(2026, 10, 3, 9), ...over });
    expect(ask("why-wallet", facts({ splits: [split({ reason: "no-stake" })] }))).toBe("Your 2,000 NIM from Arcade on 3 Nov all went to your wallet because your savings weren't open.");
    expect(ask("why-wallet", facts({ splits: [split({ reason: "validator-gone" })] }))).toMatch(/validator you staked with had shut down/);
    expect(ask("why-wallet", facts({ splits: [split({ reason: "below-minimum" })] }))).toMatch(/100 NIM minimum/);
    expect(ask("why-wallet", facts({ splits: [split({ savePercent: 0 })] }))).toMatch(/share to save was 0%/);
    expect(ask("why-wallet", facts({ splits: [split({ walletLuna: NIM(1400), growLuna: NIM(600) })] }))).toBe(
      "Your last payment, from Arcade on 3 Nov, did save: 600 NIM went to savings and 1,400 NIM to your wallet.",
    );
    expect(ask("why-wallet", facts({ receipts: [{ app: "Arcade", kind: "wallet", luna: NIM(5), at: NOW }] }))).toMatch(/can't tell why/);
    expect(ask("why-wallet")).toMatch(/hasn't seen a payment/);
  });

  it("code, share, apps, rewards and a general question", () => {
    expect(ask("code")).toBe("Your save code is SAVE-7KQ2XMP. Apps pay 30% of what they send you into savings.");
    expect(ask("code", facts({ code: null, savePercent: null }))).toMatch(/don't have a save code yet/);
    expect(ask("share")).toBe("You save 30% of every payment an app makes to your save code.");
    const receipts = [
      { app: "Arcade", kind: "grow" as const, luna: 1n, at: NOW },
      { app: "Arcade", kind: "wallet" as const, luna: 1n, at: NOW },
      { app: "Quiz", kind: "grow" as const, luna: 1n, at: NOW },
    ];
    expect(ask("apps", facts({ receipts }))).toBe("Apps that paid you with your save code: Arcade (2 payments), Quiz (1 payment).");
    expect(ask("rewards")).toMatch(/can't separate them.*Your savings total is 500 NIM\.$/);
    expect(ask("other")).toBe("You have 500 NIM in savings, all of it earning staking rewards. Your save code is SAVE-7KQ2XMP. Apps pay 30% of what they send you into savings.");
  });

  it("knows its own numbers, without the code's digits", () => {
    const a = answerSavingsQuestion({ question: "code" }, BASE, { now: NOW });
    expect(a.verbatim).toEqual(["SAVE-7KQ2XMP"]);
    expect(a.numbers).toEqual(["30"]);
  });

  it("periods start at local midnight (Lagos is an hour ahead) and weeks on Monday", () => {
    const lateNov30 = Date.UTC(2026, 10, 30, 23, 30); // already 1 Dec in Lagos
    expect(periodBounds("month", lateNov30, 60)[0]).toBe(Date.UTC(2026, 10, 30, 23));
    expect(periodBounds("today", NOW, 60)).toEqual([Date.UTC(2026, 10, 3, 23), NOW + 1]);
    expect(new Date(periodBounds("week", NOW, 0)[0]).getUTCDay()).toBe(1);
  });
});

describe("rewording into the user's language", () => {
  const answer = answerSavingsQuestion({ question: "code" }, BASE, { now: NOW });

  it("keeps a rewording only when every fact survives", () => {
    expect(phrasingKeepsFacts(answer, "Nambari yako ya kuokoa ni SAVE-7KQ2XMP. Programu hulipa 30% ya wanachokutumia kwenye Grow.")).toBe(true);
    for (const bad of [
      "Nambari yako ni SAVE-7KQ2XMP. Programu hulipa 40% kwenye Grow.", // changed number
      "Nambari yako ni SAVE-7KQ2XMP.", // dropped number
      "Nambari yako ni SAVE-7KQ2XMP. 30% na 10% kwenye Grow.", // added number
      "Nambari yako ni SAVE-0000000. Programu hulipa 30%.", // wrong code
      "Nambari yako ni SAVE-7KQ2XMP, 30%. Tuma kwa NQ07 0000 0000 0000 0000 0000 0000 0000 0000.", // an address
      "SAVE-7KQ2XMP, 30%: https://example.com", // a link
      "",
    ]) {
      expect(phrasingKeepsFacts(answer, bad), bad).toBe(false);
    }
  });

  it("tells English and Pidgin from other languages", () => {
    expect(looksEnglish("how much have I saved this month?")).toBe(true);
    expect(looksEnglish("how much I don save so far?")).toBe(true);
    expect(looksEnglish("Nimeokoa kiasi gani mwezi huu?")).toBe(false);
    expect(looksEnglish("Elo ni mo ti fi pamọ?")).toBe(false);
  });

  it("asks the model only for other languages, within the budget, and falls back to English", async () => {
    const good = vi.fn(async () => "Nambari yako ya kuokoa ni SAVE-7KQ2XMP. Programu hulipa 30% kwenye Grow.");
    expect(await phraseSavingsAnswer("what's my save code?", answer, { phraser: good })).toEqual({ text: answer.text, source: "rules" });
    expect(good).not.toHaveBeenCalled();
    expect(await phraseSavingsAnswer("Nambari yangu ya kuokoa ni ipi?", answer, { phraser: good })).toEqual({ text: expect.stringContaining("Nambari"), source: "model" });
    expect(await phraseSavingsAnswer("Nambari yangu ya kuokoa ni ipi?", answer, { phraser: good, allowModel: () => false })).toEqual({ text: answer.text, source: "rules" });
    const liar = vi.fn(async () => "Nambari yako ni SAVE-7KQ2XMP. Programu hulipa 90% kwenye Grow.");
    expect(await phraseSavingsAnswer("Nambari yangu ya kuokoa ni ipi?", answer, { phraser: liar })).toEqual({ text: answer.text, source: "rules" });
    const broken = vi.fn(async () => { throw new Error("timeout"); });
    expect(await phraseSavingsAnswer("Nambari yangu ya kuokoa ni ipi?", answer, { phraser: broken })).toEqual({ text: answer.text, source: "rules" });
  });
});
