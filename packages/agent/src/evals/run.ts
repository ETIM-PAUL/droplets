import type { CorridorId } from "@railkit/core";
import type { Bank, Draft } from "../intent";
import type { Extractor } from "../model";
import { understand } from "../understand";
import type { EvalCase } from "./sentences";

export interface CaseResult {
  text: string;
  tags: EvalCase["tags"];
  /** Fields it was expected to get, and got right. */
  hits: number;
  expected: number;
  /** Fields it filled with a value other than the expected one, or filled when it should have asked. */
  wrong: string[];
  /** Expected fields left empty (Errand will ask; slower, but safe). */
  missed: string[];
}

export interface EvalReport {
  cases: CaseResult[];
  /** Share of expected fields filled correctly. */
  recall: number;
  /** Fields filled with a wrong value. The bar for this is zero. */
  wrong: number;
}

const value = (d: Draft, k: string): string | undefined => (k === "bank" ? d.bank?.code : (d as Record<string, unknown>)[k] as string | undefined);

/** Runs the eval set through the same `understand` the API uses, with or without a model. */
export async function runEval(cases: EvalCase[], deps: { enabled: ReadonlySet<CorridorId>; banks: readonly Bank[]; model?: Extractor }): Promise<EvalReport> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    const r = await understand({ text: c.text, draft: c.draft, expecting: c.expecting }, deps);
    const res: CaseResult = { text: c.text, tags: c.tags, hits: 0, expected: 0, wrong: [], missed: [] };
    // Reading a send as a top-up or savings, or the other way round, is always wrong.
    const gotIntent = r.intent ?? "send";
    const wantIntent = c.intent ?? "send";
    if (gotIntent !== wantIntent) res.wrong.push(`intent: got ${gotIntent}, want ${wantIntent}`);
    for (const [k, want] of Object.entries(c.topup ?? {})) {
      res.expected++;
      const got = (r.topup as Record<string, string> | undefined)?.[k];
      if (got === want) res.hits++;
      else if (got === undefined) res.missed.push(`topup.${k}`);
      else res.wrong.push(`topup.${k}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
    if (c.intent === "topup" && r.topup) {
      for (const [k, got] of Object.entries(r.topup)) if (!(k in (c.topup ?? {}))) res.wrong.push(`topup.${k}: should be empty, got ${JSON.stringify(got)}`);
    }
    // Savings: every field must match, and none may be filled that the case doesn't list (an amount Errand guessed is wrong).
    for (const [k, want] of Object.entries(c.save ?? {})) {
      res.expected++;
      const got = (r.save as Record<string, unknown> | undefined)?.[k];
      if (got === want) res.hits++;
      else if (got === undefined) res.missed.push(`save.${k}`);
      else res.wrong.push(`save.${k}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
    if (c.intent === "save" && r.save) {
      for (const [k, got] of Object.entries(r.save)) if (!(k in (c.save ?? {}))) res.wrong.push(`save.${k}: should be empty, got ${JSON.stringify(got)}`);
    }
    for (const [k, want] of Object.entries(c.expect)) {
      res.expected++;
      const got = value(r.draft, k);
      if (got === want) res.hits++;
      else if (got === undefined) res.missed.push(k);
      else res.wrong.push(`${k}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
    for (const k of c.never ?? []) {
      const got = value(r.draft, k);
      if (got !== undefined) res.wrong.push(`${k}: should have asked, got ${JSON.stringify(got)}`);
    }
    results.push(res);
  }
  const expected = results.reduce((n, r) => n + r.expected, 0);
  const hits = results.reduce((n, r) => n + r.hits, 0);
  return { cases: results, recall: expected ? hits / expected : 1, wrong: results.reduce((n, r) => n + r.wrong.length, 0) };
}

export function formatReport(r: EvalReport, label: string): string {
  const lines = [`${label}: recall ${(r.recall * 100).toFixed(1)}%, wrong values ${r.wrong}, cases ${r.cases.length}`];
  for (const c of r.cases) {
    if (c.wrong.length) lines.push(`  WRONG  ${c.text}\n         ${c.wrong.join("; ")}`);
    else if (c.missed.length) lines.push(`  asks   ${c.text}  (missed ${c.missed.join(", ")})`);
  }
  return lines.join("\n");
}
