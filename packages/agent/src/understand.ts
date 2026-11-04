import type { CorridorId } from "@railkit/core";
import { matchBank, suggestBanks } from "./banks";
import { checkDraft, mergeDrafts, missingFields, questionFor, type Bank, type Draft, type Missing, type Understood } from "./intent";
import { recheck, type Extractor, type ModelFields } from "./model";
import { parseAnswer, parseSave, parseSentence, parseTopup } from "./rules";
import { looksEnglish, type SavingsClassifier } from "./save-answer";

export interface UnderstandInput {
  text: string;
  /** What Errand understood before this message, sent back by the device. Untrusted: checked again here. */
  draft?: Draft;
  /** The question this message answers, if any. */
  expecting?: Missing;
}

export interface UnderstandDeps {
  enabled: ReadonlySet<CorridorId>;
  banks: readonly Bank[];
  /** Optional. Without it Errand still understands most sentences and asks for the rest. */
  model?: Extractor;
  /** Optional. Spots savings questions that aren't in English; it may only pick a kind of question. */
  savingsClassifier?: SavingsClassifier;
  /** Called before each model call; false skips the model (budget spent). */
  allowModel?: () => boolean;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

const DROPPED: Record<keyof ModelFields, string> = {
  corridor: "",
  currency: "",
  amount: "the amount",
  phone: "the phone number",
  accountNumber: "the account number",
  name: "the name",
  bank: "the bank",
};

/**
 * One chat turn: rules first, the model only for what the rules missed, then the same checks for both.
 * Returns the draft so far, what's still missing, and the next question.
 */
export async function understand(input: UnderstandInput, deps: UnderstandDeps): Promise<Understood> {
  const text = input.text.trim().slice(0, 300);
  if (!input.expecting) {
    // About the user's own savings: straight to Savings. Rules only; the model is never asked.
    // Checked before top-ups, so "add 500 NIM to my savings" isn't read as buying NIM.
    const save = parseSave(text);
    if (save) return { intent: "save", save: save.save, draft: {}, missing: [], question: null, notes: save.notes, source: "rules" };
    // A fresh sentence asking to add money to the user's own wallet goes to Add money, not the payout questions.
    const topup = parseTopup(text);
    if (topup) return { intent: "topup", topup, draft: {}, missing: [], question: null, notes: [], source: "rules" };
  }
  const before = checkDraft(input.draft ?? {}, deps.enabled, deps.banks).draft;
  const rules = input.expecting
    ? parseAnswer(text, input.expecting, deps.enabled, deps.banks, before)
    : parseSentence(text, deps.enabled, deps.banks);

  // A message that isn't English and that the rules can't read as a payment may be a savings question.
  // The classifier only picks which question; the answer is worked out from the user's data, and nothing moves.
  const d0 = rules.draft;
  const nothingFound = !d0.amount && !d0.number && !d0.phone && !d0.accountNumber && !d0.corridor && !d0.bank && !d0.bankQuery && !d0.name;
  if (!input.expecting && nothingFound && deps.savingsClassifier && !looksEnglish(text) && (deps.allowModel?.() ?? true)) {
    try {
      const q = await deps.savingsClassifier(text);
      deps.log?.("agent savings classifier used", { question: q?.question ?? "none" });
      if (q) return { intent: "save", save: { action: "ask", ...q }, draft: {}, missing: [], question: null, notes: [], source: "model" };
    } catch (e) {
      deps.log?.("agent savings classifier failed", { error: String(e) });
    }
  }

  let draft = mergeDrafts(before, rules.draft);
  let bankChoices = rules.bankChoices;
  let source: Understood["source"] = "rules";
  const notes: string[] = [];
  const ambiguous = rules.ambiguous ?? [];
  if (ambiguous.includes("amount")) notes.push("Your message has more than one amount, so Errand will ask which one.");
  if (ambiguous.includes("number")) notes.push("Your message has more than one phone or account number, so Errand will ask which one.");

  // The model is worth a call only for a fresh sentence the rules couldn't finish.
  const first = checkDraft(draft, deps.enabled, deps.banks);
  const gaps = missingFields(first.draft);
  if (!input.expecting && gaps.length > 0 && deps.model && (deps.allowModel?.() ?? true)) {
    try {
      const { draft: fromModel, dropped } = recheck(await deps.model(text, deps.enabled), text);
      // Where the sentence itself is ambiguous, the model doesn't get to choose either.
      if (ambiguous.includes("amount")) delete fromModel.amount;
      if (ambiguous.includes("number")) for (const k of ["phone", "accountNumber"] as const) delete fromModel[k];
      // What the rules found wins; the model only fills gaps.
      draft = mergeDrafts(fromModel, draft);
      source = "rules+model";
      const lost = dropped.map((k) => DROPPED[k]).filter(Boolean);
      if (lost.length) notes.push(`Errand couldn't confirm ${lost.join(" and ")} from your message, so it will ask.`);
      deps.log?.("agent model used", { dropped });
    } catch (e) {
      deps.log?.("agent model failed", { error: String(e) });
    }
  }

  // A bank named in words (by the user or the model) is matched against the provider's list here.
  const query = draft.bankQuery;
  if (!draft.bank && query && !bankChoices) {
    const m = matchBank(query, deps.banks, { answer: true });
    if (m.bank) draft = mergeDrafts(draft, { bank: m.bank });
    // No outright match: offer the nearest names rather than asking the user to guess the list's spelling.
    bankChoices = m.choices ?? (m.bank ? undefined : suggestBanks(query, deps.banks));
  }

  const checked = checkDraft(draft, deps.enabled, deps.banks);
  notes.push(...checked.notes);
  const missing = missingFields(checked.draft);
  const ask = missing[0];
  return {
    draft: checked.draft,
    missing,
    question: !ask ? null : ask === "bank" && bankChoices?.length ? "Which of these banks is it?" : questionFor(ask, checked.draft, deps.enabled),
    ...(ask === "bank" && bankChoices?.length ? { bankChoices } : {}),
    notes,
    source,
  };
}
