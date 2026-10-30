import type { CorridorId } from "@railkit/core";
import { expect, it } from "vitest";
import { formatReport, runEval } from "./evals/run";
import { EVAL_CASES } from "./evals/sentences";
import banksJson from "./fixtures/banks-ng.json";
import type { Bank } from "./intent";

/**
 * The eval bar, enforced in CI on the free, deterministic rules (no model):
 * zero wrong values (a wrong amount, number or bank is worse than a question), and recall at or above the bar.
 * Raise RECALL_BAR as the rules improve; never lower it to make a change pass.
 */
const RECALL_BAR = 0.95;

it("meets the eval bar with rules only", async () => {
  const report = await runEval(EVAL_CASES, { enabled: new Set<CorridorId>(["ke-mpesa", "ng-bank"]), banks: banksJson as Bank[] });
  console.log(formatReport(report, "rules only"));
  expect(report.cases.filter((c) => c.wrong.length).map((c) => `${c.text} → ${c.wrong.join("; ")}`)).toEqual([]);
  expect(report.recall).toBeGreaterThanOrEqual(RECALL_BAR);
});
