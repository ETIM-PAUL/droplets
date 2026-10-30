import { parsePaymentInput, type ParsedPayment } from "./parse";

/** Query parameters that carry a payment string inside a link or a BIP21 URI. */
const CARRIER_PARAMS = ["lightning", "lnurl", "pr", "invoice", "lnaddress"];

const TOKEN_PATTERNS = [
  /\bln(?:bcrt|bc|tbs|tb)\d*[munp]?1[02-9ac-hj-np-z]{50,}\b/gi,
  /\blnurl1[02-9ac-hj-np-z]{20,}\b/gi,
  /\b(?:lnurlp|lnurlw):\/\/[^\s"'<>]+/gi,
  /\b0x[0-9a-f]{40}\b/gi,
];

/**
 * Every string inside a QR's text that could be a payment request, most specific first: the whole text,
 * payment parameters of a link or `bitcoin:` URI, then anything that looks like an invoice, LNURL,
 * Lightning Address or wallet address. Candidates are always substrings of the text, never rewritten.
 */
export function findPaymentCandidates(text: string): string[] {
  const t = text.trim().slice(0, 4096);
  const out: string[] = [];
  const add = (s: string | null | undefined) => {
    const v = s?.trim().replace(/^lightning:/i, "");
    if (v && !out.includes(v)) out.push(v);
  };
  add(t);

  // bitcoin:bc1...?amount=...&lightning=lnbc... and https://pay.example/?lightning=LNURL1...
  const query = t.includes("?") ? t.slice(t.indexOf("?") + 1) : "";
  for (const part of query.split("&")) {
    const [k, v] = part.split("=");
    if (k && v && CARRIER_PARAMS.includes(k.toLowerCase())) {
      try {
        add(decodeURIComponent(v));
      } catch {
        add(v);
      }
    }
  }
  for (const re of TOKEN_PATTERNS) for (const m of t.matchAll(re)) add(m[0]);
  // An email-shaped string is only a Lightning Address when the text says it's about Lightning.
  if (/lightning|⚡|\bsats?\b|lnaddress/i.test(t)) for (const m of t.matchAll(/\b[a-z0-9._+-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi)) add(m[0]);
  return out;
}

export type ResolvedText =
  | { status: "found"; payment: ParsedPayment; candidate: string }
  /** Several different payment requests in one QR: Errand won't pick one. */
  | { status: "ambiguous"; candidates: string[] }
  | { status: "none" };

const key = (p: ParsedPayment): string => {
  switch (p.kind) {
    case "bolt11": return `bolt11:${p.paymentHash}`;
    case "lnurl":
    case "lightning-address": return `lnurl:${p.url}`;
    case "evm-address": return `evm:${p.address.toLowerCase()}`;
    case "emvco": return "emvco";
  }
};

/**
 * Finds the one payment request in a QR's text, offline. A BIP21 URI with both an on-chain address and a
 * Lightning invoice counts as one request (the invoice), since that's the part Nimiq Pay can pay.
 */
export function resolvePaymentText(text: string): ResolvedText {
  const found = new Map<string, { payment: ParsedPayment; candidate: string }>();
  for (const c of findPaymentCandidates(text)) {
    const r = parsePaymentInput(c);
    if (r.ok && !found.has(key(r.value))) found.set(key(r.value), { payment: r.value, candidate: c });
  }
  if (found.size === 0) return { status: "none" };
  if (found.size === 1) return { status: "found", ...[...found.values()][0]! };
  return { status: "ambiguous", candidates: [...found.values()].map((f) => f.candidate) };
}

const NON_PAYMENT: [RegExp, string][] = [
  [/^WIFI:/i, "Wi-Fi login details"],
  [/^(BEGIN:VCARD|MECARD:)/i, "a contact card"],
  [/^BEGIN:VEVENT/i, "a calendar event"],
  [/^tel:/i, "a phone number"],
  [/^(mailto:|MATMSG:)/i, "an email address"],
  [/^(SMSTO?:|sms:)/i, "a text message"],
  [/^geo:/i, "a map location"],
  [/^https?:\/\/[^\s]+$/i, "a website link"],
];

/**
 * Common QR codes that are never payments, named on the phone so their contents (Wi-Fi passwords,
 * contacts) are never sent to Errand's server or a model. Null when the text could still hold a payment.
 */
export function nonPaymentKind(text: string): string | null {
  const t = text.trim();
  if (resolvePaymentText(t).status !== "none") return null;
  return NON_PAYMENT.find(([re]) => re.test(t))?.[1] ?? null;
}
