import {
  CALLING_CODE,
  CORRIDORS,
  isCorridorId,
  normalizePhone,
  validatePayoutAmount,
  type CorridorId,
} from "@railkit/core";

export interface Bank {
  name: string;
  code: string;
}

/**
 * What Errand has understood so far about a "send money" request. Every field is optional:
 * the chat asks for whatever is missing. Nothing here is trusted until `checkDraft` has run.
 */
export interface Draft {
  corridor?: CorridorId;
  /** Major units, e.g. "2500". Always in the corridor's currency once a corridor is known. */
  amount?: string;
  currency?: string;
  /** A long number not yet known to be a phone or an account number (the corridor decides). */
  number?: string;
  phone?: string;
  name?: string;
  /** The words the user used for their bank, e.g. "gtbank". */
  bankQuery?: string;
  bank?: Bank;
  accountNumber?: string;
}

export type Missing = "corridor" | "amount" | "phone" | "name" | "bank" | "account";

/** "buy 100 NIM", "add ₦10,000 to my wallet": money coming in, not going out. */
export interface TopupIntent {
  /** Fiat to pay, when the user said one ("add ₦10,000"). */
  amount?: string;
  currency?: string;
  /** NIM wanted, when the user said that instead ("buy 100 NIM"). */
  nim?: string;
}

export interface Understood {
  /** "send" (the default) asks questions until a payout can be quoted; "topup" hands over to Add money. */
  intent?: "send" | "topup";
  topup?: TopupIntent;
  draft: Draft;
  missing: Missing[];
  /** The next thing to ask, or null when the draft is ready for a quote. */
  question: string | null;
  /** Set when the bank words matched more than one bank. */
  bankChoices?: Bank[];
  /** Things Errand couldn't use, said plainly (e.g. "The smallest M-Pesa payout is 150 KES."). */
  notes: string[];
  source: "rules" | "model" | "rules+model";
}

export const MISSING_ORDER: Missing[] = ["corridor", "amount", "phone", "account", "bank", "name"];

export const network = (c: CorridorId) => CORRIDORS[c].label.split(": ")[1]!;

/** What is still needed before Errand can quote. Nigerian bank payouts look the name up, so they don't ask for it. */
export function missingFields(d: Draft): Missing[] {
  if (!d.corridor) return ["corridor", ...(d.amount ? [] : (["amount"] as const))];
  const c = CORRIDORS[d.corridor];
  const out: Missing[] = [];
  if (!d.amount) out.push("amount");
  if (c.recipientType === "mobile-money") {
    if (!d.phone) out.push("phone");
    if (!d.name) out.push("name");
  } else {
    if (!d.accountNumber) out.push("account");
    if (!d.bank) out.push("bank");
    if (c.country !== "NG" && !d.name) out.push("name");
  }
  return MISSING_ORDER.filter((m) => out.includes(m));
}

export function questionFor(m: Missing, d: Draft, enabled: ReadonlySet<CorridorId>): string {
  const c = d.corridor ? CORRIDORS[d.corridor] : null;
  switch (m) {
    case "corridor": {
      const names = [...enabled].map((id) => CORRIDORS[id].label.replace(": ", " "));
      return names.length ? `Where should the money go? Errand can send to ${names.join(" or ")}.` : "Sending is paused right now. Try again later.";
    }
    case "amount":
      return `How much should they get${c ? `, in ${c.currency}` : ""}?`;
    case "phone":
      return `What's their ${network(d.corridor!)} number?`;
    case "name":
      return c?.recipientType === "mobile-money" ? `What's their name, as it shows on ${network(d.corridor!)}?` : "What's the account holder's name?";
    case "bank":
      return d.bankQuery ? `Errand couldn't find "${d.bankQuery}" in the bank list. Which bank is the account with?` : "Which bank is the account with?";
    case "account":
      return c?.country === "NG" ? "What's the 10-digit account number?" : "What's the account number?";
  }
}

const NAME = /^[\p{L}][\p{L}' .-]{0,59}$/u;
const digitsOf = (s: string) => s.replace(/\D/g, "");

/**
 * Turns an untrusted draft (from the user's device, the rules or the model) into one Errand can use:
 * unknown or disabled corridors dropped, numbers checked, wrong currencies and too-small amounts explained.
 * The corridor decides whether a loose number is a phone or an account number.
 */
export function checkDraft(raw: Draft, enabled: ReadonlySet<CorridorId>, banks: readonly Bank[] = []): { draft: Draft; notes: string[] } {
  const notes: string[] = [];
  const d: Draft = {};
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined);

  const corridor = str(raw.corridor, 20);
  if (corridor && isCorridorId(corridor)) {
    if (enabled.has(corridor)) d.corridor = corridor;
    else notes.push(`Errand doesn't send to ${CORRIDORS[corridor].label.replace(": ", " ")} right now.`);
  }
  const c = d.corridor ? CORRIDORS[d.corridor] : null;

  const amount = str(raw.amount, 24);
  const currency = str(raw.currency, 8)?.toUpperCase();
  if (amount) {
    if (c && currency && currency !== c.currency) {
      notes.push(`${network(c.id)} pays out in ${c.currency}, so Errand needs the amount in ${c.currency}.`);
    } else if (c) {
      const v = validatePayoutAmount(c.id, { amount, currency: c.currency });
      if (v.ok) d.amount = v.value.amount;
      else notes.push(v.error.message);
    } else if (/^\d+(\.\d{1,2})?$/.test(amount)) {
      d.amount = amount;
      if (currency) d.currency = currency;
    }
  }
  if (c && d.amount) d.currency = c.currency;

  const number = digitsOf(str(raw.number, 24) ?? "");
  const phoneIn = str(raw.phone, 24) ?? (c?.recipientType === "mobile-money" && number ? number : undefined);
  const accountIn = digitsOf(str(raw.accountNumber, 24) ?? (c?.recipientType === "bank" ? number : ""));
  if (!c && number) d.number = number;

  if (phoneIn && c?.recipientType === "mobile-money") {
    const p = normalizePhone(phoneIn, c.country);
    const national = p.ok ? p.value.slice(1 + CALLING_CODE[c.country].length) : "";
    if (!p.ok) notes.push(p.error.message);
    else if (c.prefixes && !c.prefixes.some((x) => national.startsWith(x))) notes.push(`That number isn't on ${network(c.id)}. Check the number.`);
    else d.phone = p.value;
  } else if (phoneIn && !c && !d.number) {
    // Until the corridor is known, a number is just a number: neither a phone nor an account.
    d.number = digitsOf(phoneIn);
  }

  if (accountIn && c?.recipientType === "bank") {
    if (c.country === "NG" && !/^\d{10}$/.test(accountIn)) notes.push("Nigerian account numbers have 10 digits.");
    else if (!/^\d{6,20}$/.test(accountIn)) notes.push("That account number doesn't look right.");
    else d.accountNumber = accountIn;
  }

  const name = str(raw.name, 60);
  if (name && NAME.test(name)) d.name = name.replace(/\s+/g, " ");

  // A bank only counts if it is on the provider's list, matched by code.
  if (raw.bank && typeof raw.bank === "object") {
    const b = banks.find((x) => x.code === raw.bank!.code);
    if (b) d.bank = b;
  }
  const bankQuery = str(raw.bankQuery, 60);
  if (bankQuery && !d.bank) d.bankQuery = bankQuery;

  return { draft: d, notes };
}

/** Later answers win, except that a field the user didn't mention keeps its earlier value. */
export function mergeDrafts(earlier: Draft, later: Draft): Draft {
  const out: Draft = { ...earlier };
  for (const [k, v] of Object.entries(later)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  if (later.bank) delete out.bankQuery;
  if (later.bankQuery && !later.bank) delete out.bank;
  return out;
}
