import { CORRIDORS, type CorridorId } from "@railkit/core";
import { matchBank } from "./banks";
import type { Bank, Draft, Missing, SaveIntent, SavePeriod, SaveQuestion, TopupIntent } from "./intent";

/** Words for money, rewritten to ISO codes before anything else reads the sentence. */
const CURRENCY_WORDS: [RegExp, string][] = [
  [/₦\s*/g, " NGN "],
  [/\bN(?=\d)/g, " NGN "],
  [/\b(naira|ngn)\b/gi, " NGN "],
  [/\bk\s?shs?\.?(?=\s|\d|$)/gi, " KES "],
  [/\b(kes|shillings?|bob)\b/gi, " KES "],
  [/\b(ghs|cedis?)\b/gi, " GHS "],
  [/₵\s*/g, " GHS "],
  [/\b(zar|rands?)\b/gi, " ZAR "],
  [/\bR(?=\d)/g, " ZAR "],
];

const CURRENCY_CORRIDOR: Record<string, CorridorId[]> = {
  KES: ["ke-mpesa", "ke-airtel"],
  NGN: ["ng-bank"],
  GHS: ["gh-mtn"],
  ZAR: ["za-bank"],
};

const COUNTRY_WORDS: [RegExp, CorridorId[]][] = [
  [/\bkenya\b/i, ["ke-mpesa", "ke-airtel"]],
  [/\bnigeria\b/i, ["ng-bank"]],
  [/\bghana\b/i, ["gh-mtn"]],
  [/\bsouth africa\b/i, ["za-bank"]],
];

const CALLING: [string, CorridorId[]][] = [
  ["254", ["ke-mpesa", "ke-airtel"]],
  ["234", ["ng-bank"]],
  ["233", ["gh-mtn"]],
  ["27", ["za-bank"]],
];

/** Words that are never part of a person's name in a sentence like "send 2,500 to Mary Wanjiku on M-Pesa". */
const NOT_NAMES = /^(m-?pesa|mtn|momo|airtel|kenya|nigeria|ghana|south|africa|bank|kes|ngn|ghs|zar|ksh|naira|account|number|errand|nimiq|my|our|their|his|her)$/i;
const RELATIONS = "mum|mom|mother|mama|dad|father|baba|sister|brother|wife|husband|aunt|aunty|auntie|uncle|cousin|friend|son|daughter|grandma|granny|grandpa";

export interface RuleResult {
  draft: Draft;
  bankChoices?: Bank[];
  /** The sentence had more than one of these, so Errand asks instead of picking one. */
  ambiguous?: ("amount" | "number")[];
}

/**
 * Reads a sentence with plain rules: amounts, currencies, networks, countries, phone and account numbers,
 * a capitalised name after "to" or "for", and a bank from the provider's list. Free and offline; the model
 * is only asked about what these rules leave out.
 */
export function parseSentence(input: string, enabled: ReadonlySet<CorridorId>, banks: readonly Bank[] = []): RuleResult {
  let text = ` ${input.normalize("NFKC").slice(0, 300)} `;
  for (const [re, iso] of CURRENCY_WORDS) text = text.replace(re, iso);
  const d: Draft = {};

  // Long digit runs first (phones, account numbers), so their digits aren't read as an amount.
  const longNumbers: string[] = [];
  text = text.replace(/\+?\d(?:[ -]?\d){8,14}(?!\d)/g, (m) => {
    longNumbers.push(m.replace(/[ -]/g, ""));
    return " ";
  });

  const ambiguous: ("amount" | "number")[] = [];
  const AMOUNT = /(?:\b(KES|NGN|GHS|ZAR)\s*)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\s*(k|thousand)?\b\s*(KES|NGN|GHS|ZAR)?/gi;
  const amounts = [...text.matchAll(AMOUNT)];
  if (new Set(amounts.map((m) => m[0].replace(/[\s,]/g, "").toUpperCase())).size > 1) ambiguous.push("amount");
  if (new Set(longNumbers).size > 1) ambiguous.push("number");
  const amount = ambiguous.includes("amount") ? undefined : amounts[0];
  if (amount) {
    let whole = amount[2]!.replace(/,/g, "");
    let frac = amount[3] ?? "";
    if (amount[4]) {
      // "2.5k" → 2500
      const v = BigInt(whole) * 1000n + (frac ? BigInt(frac.slice(1).padEnd(3, "0")) : 0n);
      [whole, frac] = [v.toString(), ""];
    }
    d.amount = whole.replace(/^0+(?=\d)/, "") + frac;
    const cur = amount[1] ?? amount[5];
    if (cur) d.currency = cur.toUpperCase();
  }
  const anyCurrency = /\b(KES|NGN|GHS|ZAR)\b/.exec(text);
  if (!d.currency && anyCurrency) d.currency = anyCurrency[1];

  // Corridor: the network named, then the currency, the country, the calling code, and a bank.
  const candidates: CorridorId[][] = [];
  if (/\bm-?pesa\b/i.test(text)) candidates.push(["ke-mpesa"]);
  if (/\bairtel\b/i.test(text)) candidates.push(["ke-airtel"]);
  if (/\b(mtn|momo)\b/i.test(text)) candidates.push(["gh-mtn"]);
  // Networks and countries the user named outright; the rest (currency, calling code, "bank") are hints.
  const named = new Set(candidates);
  for (const [re, ids] of COUNTRY_WORDS) if (re.test(text)) named.add(ids);
  if (d.currency && CURRENCY_CORRIDOR[d.currency]) candidates.push(CURRENCY_CORRIDOR[d.currency]!);
  for (const [re, ids] of COUNTRY_WORDS) if (re.test(text)) candidates.push(ids);
  for (const n of longNumbers) for (const [code, ids] of CALLING) if (n.replace("+", "").startsWith(code) && n.replace("+", "").length >= code.length + 9) candidates.push(ids);

  const bankMatch = banks.length ? matchBank(text, banks) : {};
  const mentionsBank = !!(bankMatch.bank || bankMatch.choices) || /\bbank\b/i.test(text);
  if (mentionsBank) candidates.push(["ng-bank", "za-bank"]);

  // The first candidate set that names exactly one enabled corridor wins; with one corridor live, it's that one.
  const ordered = [...candidates.filter((c) => named.has(c)), ...candidates.filter((c) => !named.has(c))];
  for (const ids of ordered) {
    const live = ids.filter((id) => enabled.has(id));
    if (live.length === 0 && named.has(ids)) {
      // They named somewhere Errand doesn't send to: say so (checkDraft explains), never switch countries.
      d.corridor = ids[0];
      break;
    }
    if (live.length === 1) {
      d.corridor = live[0];
      break;
    }
    if (live.length > 1 && ids[0] === "ke-mpesa" && ids.length === 2) {
      // KES with no network named: M-Pesa is what nearly everyone in Kenya uses.
      d.corridor = enabled.has("ke-mpesa") ? "ke-mpesa" : live[0];
      break;
    }
  }
  if (!d.corridor && candidates.length === 0 && enabled.size === 1) d.corridor = [...enabled][0];

  const number = ambiguous.includes("number") ? undefined : longNumbers[0];
  if (number) d.number = number;
  if (d.corridor && enabled.has(d.corridor) && number) {
    if (CORRIDORS[d.corridor].recipientType === "mobile-money") d.phone = number;
    else d.accountNumber = number;
    delete d.number;
  }

  if (bankMatch.bank) d.bank = bankMatch.bank;
  else if (bankMatch.choices) d.bankQuery = input.trim().slice(0, 60);

  const name = new RegExp(`\\b(?:to|for)\\s+(?:my\\s+(?:${RELATIONS})\\s+)?((?:[A-Z][\\p{L}'-]+)(?:\\s+[A-Z][\\p{L}'-]+){0,3})`, "u").exec(text);
  if (name) {
    const parts = name[1]!.split(/\s+/);
    const cut = parts.findIndex((w) => NOT_NAMES.test(w) || (bankMatch.bank && bankMatch.bank.name.toLowerCase().includes(w.toLowerCase())));
    const kept = (cut === -1 ? parts : parts.slice(0, cut)).join(" ");
    if (kept && !/^[A-Z]{2,}$/.test(kept)) d.name = kept;
  }

  return { draft: d, bankChoices: bankMatch.choices, ...(ambiguous.length ? { ambiguous } : {}) };
}

/**
 * A short reply to Errand's last question ("Mary", "0712 345 678", "Zenith") is read as the answer to it,
 * so a follow-up never needs the model.
 */
export function parseAnswer(text: string, expecting: Missing, enabled: ReadonlySet<CorridorId>, banks: readonly Bank[], current: Draft): RuleResult {
  const t = text.trim().slice(0, 120);
  switch (expecting) {
    case "name":
      if (/^[\p{L}][\p{L}' .-]{0,59}$/u.test(t) && t.split(/\s+/).length <= 4) return { draft: { name: t } };
      break;
    case "phone":
    case "account": {
      const digits = t.replace(/[\s-]/g, "");
      if (!/^\+?\d{6,15}$/.test(digits)) break;
      return { draft: expecting === "phone" ? { phone: digits } : { accountNumber: digits } };
    }
    case "bank": {
      const m = matchBank(t, banks, { answer: true });
      if (m.bank) return { draft: { bank: m.bank } };
      if (m.choices) return { draft: { bankQuery: t }, bankChoices: m.choices };
      return { draft: { bankQuery: t } };
    }
    case "amount": {
      const r = parseSentence(t, enabled, banks).draft;
      if (r.amount) return { draft: { amount: r.amount, currency: r.currency ?? (current.corridor ? CORRIDORS[current.corridor].currency : undefined) } };
      break;
    }
    case "corridor": {
      const r = parseSentence(t, enabled, banks).draft;
      if (r.corridor) return { draft: { corridor: r.corridor } };
      break;
    }
  }
  // Not a plain answer: read it as a whole sentence instead ("actually make it 3000").
  return parseSentence(t, enabled, banks);
}

const TOPUP_VERB = /\b(buy|top\s?up|topup|fund|load|deposit|add(\s+money)?|get)\b/i;
const TOPUP_TARGET = /\b(nim|nimiq|my\s+(wallet|balance|nimiq|account|errand))\b/i;
/** Words that make "top up" about a phone or a person, not the user's own wallet. */
const NOT_TOPUP = /\b(airtime|data|phone|recharge|send|transfer|pay|m-?pesa|airtel|mtn|momo|bank|to\s+my\s+(mum|mom|mother|dad|father|sister|brother|wife|husband|friend|son|daughter))\b/i;
/** "for Grace": a named person, so it's for someone else. Case matters here, so it's separate. */
const FOR_SOMEONE = /\b(for|to|top\s?up)\s+[A-Z][a-z]/;

/**
 * Spots a request to put money into the user's own wallet. Deliberately narrow: a phone or account number,
 * or any word about someone else, keeps it a send, because reading a payout as a top-up (or the other way)
 * is the misread that matters. "top up 5000 naira" with nothing else counts: there is nobody to send to.
 */
export function parseTopup(input: string): TopupIntent | null {
  let text = ` ${input.normalize("NFKC").slice(0, 300)} `;
  if (!TOPUP_VERB.test(text) || NOT_TOPUP.test(text) || FOR_SOMEONE.test(text.replace(/\b(to|for)\s+(NIM|Nimiq|Errand)\b/g, ""))) return null;
  if (/\+?\d(?:[ -]?\d){8,14}/.test(text)) return null;
  const bareTopUp = /\btop\s?up\b/i.test(text);
  if (!TOPUP_TARGET.test(text) && !bareTopUp) return null;

  for (const [re, iso] of CURRENCY_WORDS) text = text.replace(re, iso);
  const m = /(?:\b(KES|NGN|GHS|ZAR)\s*)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\s*(k|thousand)?\b\s*(KES|NGN|GHS|ZAR|NIM)?/i.exec(text);
  if (!m) return {};
  let whole = m[2]!.replace(/,/g, "");
  let frac = m[3] ?? "";
  if (m[4]) {
    whole = (BigInt(whole) * 1000n + (frac ? BigInt(frac.slice(1).padEnd(3, "0")) : 0n)).toString();
    frac = "";
  }
  const amount = whole.replace(/^0+(?=\d)/, "") + frac;
  const unit = (m[1] ?? m[5] ?? (/\bnim\b/i.test(text) && !/\b(KES|NGN|GHS|ZAR)\b/.test(text) ? "NIM" : ""))?.toUpperCase();
  if (unit === "NIM") return { nim: amount };
  return unit ? { amount, currency: unit } : { amount };
}

// ---- Errand Save: the user's own savings. Narrow on purpose, like top-ups: anything about another person,
// a phone or account number, a bank or a fiat amount is a send, never savings.

const SAVE_NOUN = /\b(savings?|grow|save\s?code|saved|saving)\b/i;
const SAVE_VERB = /\bsave\b/i;
const NOT_SAVE = /(₦|\b(naira|ngn|kes|ksh|shillings?|bob|ghs|cedis?|zar|rands?|m-?pesa|airtel|mtn|momo|airtime|data|bank|lightning|invoice)\b)/i;
/** "the savings", "my Grow": nouns that look like a name after "to" but aren't one. */
const SAVE_PLACES = /\b(to|for|into|in|from|out\s+of)\s+(my\s+|the\s+)?(grow|savings?|save\s?code|nim|nimiq|errand)\b/gi;
const SAVE_REVOKE = /\b(turn\s+off|switch\s+off|stop|disable|cancel|delete|revoke)\b[^.!?]*\b(save\s?code|savings?|saving)\b|\bstop\s+saving\b/i;
const SAVE_PERCENT = /(\d{1,3}(?:\.\d+)?)\s*(?:%|per\s?cent\b)/i;
const SAVE_WITHDRAW = /\b(withdraw|unstake|cash\s?out|(?:take|pull|get)\s+(?:[\w,.]+\s+){0,5}?(?:out|back))\b/i;
const SAVE_ADD = /\b(put|add|move|send|transfer|deposit|stake|top\s?up|save)\b/i;
const SAVE_AMOUNT = /(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,5})?\s*(k|thousand)?\b/gi;
const SAVE_QUESTION = /\?\s*$|^(how|when|why|what|what'?s|which|where|who|is|are|did|do|does|can|have|has)\b/i;
const SAVE_WHEN_MONEY = /\b(when|how\s+long)\b[^?]*\b(get|withdraw(al|ing)?|released?|ready|available)\b/i;
const SAVE_WHY_WALLET = /\bwhy\b[^?]*\b(wallet|didn'?t|did\s+not|wasn'?t|was\s+not|not|no)\b/i;

/** Which question it is. Order matters: the most specific words win. */
function classifyQuestion(text: string): { question: SaveQuestion; period?: SavePeriod } {
  if (/\b(rewards?|interest|earn(ed|ing|s)?|yield|profit|apy|apr)\b/i.test(text)) return { question: "rewards" };
  if (SAVE_WHEN_MONEY.test(text) || /\bhow\s+long\b|\b(withdrawal|released?)\b/i.test(text)) return { question: "release" };
  if (/\bwhy\b/i.test(text)) return { question: "why-wallet" };
  if (/\b(save\s?code|my\s+code)\b/i.test(text)) return { question: "code" };
  if (/\b(percent|share|how\s+much\s+of)\b|%/i.test(text)) return { question: "share" };
  if (/\b(which|what|who)\b[^?]*\b(apps?|paid|pays|paying)\b/i.test(text)) return { question: "apps" };
  const period: SavePeriod | undefined = /\btoday\b/i.test(text) ? "today" : /\bthis\s+week\b/i.test(text) ? "week" : /\blast\s+month\b/i.test(text) ? "last-month" : /\bthis\s+month\b/i.test(text) ? "month" : undefined;
  if (period) return { question: "period", period };
  if (/\b(how\s+much|total|balance|have\s+i\s+saved)\b/i.test(text)) return { question: "balance" };
  return { question: "other" };
}

/**
 * Spots a request about the user's own savings: set the share ("save 30%"), add ("put 500 NIM in Grow"),
 * withdraw ("take 200 NIM out of savings"), turn the code off, or just look ("how much have I saved?").
 * Amounts are NIM, since savings are NIM. "buy 100 NIM to save" stays a top-up: buying comes first.
 */
export function parseSave(input: string): { save: SaveIntent; notes: string[] } | null {
  const text = ` ${input.normalize("NFKC").slice(0, 300)} `;
  const noun = SAVE_NOUN.test(text);
  const asking = SAVE_QUESTION.test(input.trim());
  // Two questions about savings that don't say "savings": "when can I get my money?", "why did it go to my wallet?"
  const savingsQuestion = asking && (SAVE_WHEN_MONEY.test(text) || (SAVE_WHY_WALLET.test(text) && /\b(pay|paid|payment|money|went|go|gone)\b/i.test(text)));
  if (!noun && !SAVE_VERB.test(text) && !savingsQuestion) return null;
  if (NOT_SAVE.test(text) || /\+?\d(?:[ -]?\d){8,14}/.test(text)) return null;
  // Buying NIM is a top-up, even when it's for savings: Add money first, then savings.
  if (/\bbuy\b/i.test(text)) return null;
  const others = text.replace(SAVE_PLACES, " ");
  if (/\b(for|to)\s+[A-Z][a-z]/.test(others) || new RegExp(`\\b(for|to)\\s+my\\s+(${RELATIONS})\\b`, "i").test(text)) return null;

  const notes: string[] = [];
  // A question with no amount or share in it is answered, not acted on. "Can I withdraw 200 NIM?" is still a withdrawal.
  if (asking && !SAVE_PERCENT.test(text) && ![...text.matchAll(SAVE_AMOUNT)].length) return { save: { action: "ask", ...classifyQuestion(text) }, notes };
  if (SAVE_REVOKE.test(text)) return { save: { action: "revoke" }, notes };

  const pct = SAVE_PERCENT.exec(text);
  if (pct) {
    const n = Number(pct[1]);
    if (Number.isInteger(n) && n <= 100) return { save: { action: "rule", savePercent: n }, notes };
    notes.push("The share to save is a whole percent from 0 to 100, so Errand will ask.");
    return { save: { action: "rule" }, notes };
  }

  const seen = new Set<string>();
  for (const m of text.matchAll(SAVE_AMOUNT)) {
    let whole = m[1]!.replace(/,/g, "");
    let frac = m[2] ?? "";
    if (m[3]) {
      whole = (BigInt(whole) * 1000n + (frac ? BigInt(frac.slice(1).padEnd(3, "0").slice(0, 3)) : 0n)).toString();
      frac = "";
    }
    seen.add(whole.replace(/^0+(?=\d)/, "") + frac);
  }
  if (seen.size > 1) notes.push("Your message has more than one amount, so Errand will ask which one.");
  const nim = seen.size === 1 ? [...seen][0] : undefined;
  const amount = nim && nim.replace(/\..*/, "").length <= 12 ? { nim } : {};

  // "save code" is a thing, not the verb "save".
  const verbs = text.replace(/\bsave\s?code\b/gi, " ");
  if (SAVE_WITHDRAW.test(verbs)) {
    const all = !nim && /\b(all|everything|whole)\b/i.test(text);
    return { save: { action: "withdraw", ...amount, ...(all ? { all: true } : {}) }, notes };
  }
  if (SAVE_ADD.test(verbs) && (noun || nim)) return { save: { action: "add", ...amount }, notes };
  if (noun) return { save: { action: "show" }, notes };
  return null;
}
