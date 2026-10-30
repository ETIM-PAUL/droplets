// Runs the eval set with the real model (costs ~$0.02 per run). Not in CI: it needs a key and isn't deterministic.
// The bar is the same as CI's: zero wrong values. Recall should be at least the rules-only recall.
import type { CorridorId } from "@railkit/core";
import banks from "../fixtures/banks-ng.json" with { type: "json" };
import type { Bank } from "../intent";
import { openAiExtractor } from "../model";
import { formatReport, runEval } from "./run";
import { EVAL_CASES } from "./sentences";

const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error("Set OPENAI_API_KEY in .env to run the model eval.");
const enabled = new Set<CorridorId>(["ke-mpesa", "ng-bank"]);
const rules = await runEval(EVAL_CASES, { enabled, banks: banks as Bank[] });
const withModel = await runEval(EVAL_CASES, { enabled, banks: banks as Bank[], model: openAiExtractor({ apiKey: key, model: process.env.OPENAI_MODEL || undefined }) });
console.log(formatReport(rules, "rules only"));
console.log(formatReport(withModel, `rules + ${process.env.OPENAI_MODEL || "gpt-4.1-mini"}`));
if (withModel.wrong > 0) {
  console.error("FAIL: the model introduced wrong values.");
  process.exit(1);
}
