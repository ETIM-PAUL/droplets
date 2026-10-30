import { CORRIDORS, type CorridorId } from "@railkit/core";
import { matchBank } from "./banks";
import type { Bank, Draft, Missing, TopupIntent } from "./intent";

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
