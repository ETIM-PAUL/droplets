import type { CountryCode } from "./phone";
import { CALLING_CODE, normalizePhone } from "./phone";
import { fail, ok, type Result } from "./result";
import { isDecimal, toScaled, fromScaled, type Money } from "./money";

export type MobileNetwork = "mpesa" | "airtel" | "mtn";

export type PayoutRecipient =
  | { type: "mobile-money"; phone: string; name: string; network: MobileNetwork }
  | { type: "bank"; bankCode?: string; bankName: string; accountNumber: string; accountName: string };

/** A fiat payout to a person, through a corridor. Built by the UI or the agent, never parsed from free text. */
export interface FiatPayoutDestination {
  kind: "fiat-payout";
  corridor: CorridorId;
  recipient: PayoutRecipient;
}

export type CorridorId = "ke-mpesa" | "ke-airtel" | "ng-bank" | "gh-mtn" | "za-bank";

export interface Corridor {
  id: CorridorId;
  label: string;
  country: CountryCode;
  currency: string;
  recipientType: PayoutRecipient["type"];
  network?: MobileNetwork;
  /** Smallest payout in major units; null when the provider hasn't told us. */
  minAmount: string | null;
  /** National number prefixes the network accepts (after the calling code). */
  prefixes?: string[];
}

export const CORRIDORS: Record<CorridorId, Corridor> = {
  // Minimum seen as a Mavapay staging error on 2026-10-26.
  "ke-mpesa": { id: "ke-mpesa", label: "Kenya: M-Pesa", country: "KE", currency: "KES", recipientType: "mobile-money", network: "mpesa", minAmount: "150", prefixes: ["7", "1"] },
  "ke-airtel": { id: "ke-airtel", label: "Kenya: Airtel Money", country: "KE", currency: "KES", recipientType: "mobile-money", network: "airtel", minAmount: "150", prefixes: ["7", "1"] },
  // Minimum from a Mavapay staging error on 2026-10-30.
  "ng-bank": { id: "ng-bank", label: "Nigeria: bank account", country: "NG", currency: "NGN", recipientType: "bank", minAmount: "2000" },
  // MTN prefixes as listed in a Mavapay validation error on 2026-10-26.
  "gh-mtn": { id: "gh-mtn", label: "Ghana: MTN MoMo", country: "GH", currency: "GHS", recipientType: "mobile-money", network: "mtn", minAmount: null, prefixes: ["24", "25", "53", "54", "55", "59"] },
  "za-bank": { id: "za-bank", label: "South Africa: bank account", country: "ZA", currency: "ZAR", recipientType: "bank", minAmount: null },
};

export const isCorridorId = (s: string): s is CorridorId => s in CORRIDORS;

/** Checks and normalises a recipient for its corridor. Messages are safe to show the user. */
export function validateRecipient(corridorId: CorridorId, r: PayoutRecipient): Result<PayoutRecipient> {
  const c = CORRIDORS[corridorId];
  if (r.type !== c.recipientType) return fail("unsupported", `${c.label} pays to a ${c.recipientType === "bank" ? "bank account" : "phone number"}.`);

  if (r.type === "mobile-money") {
    const name = r.name.trim();
    if (!name || name.length > 100) return fail("unrecognised", "Enter the recipient's name as it appears on their mobile money account.");
    const phone = normalizePhone(r.phone, c.country);
    if (!phone.ok) return phone;
    const national = phone.value.slice(1 + CALLING_CODE[c.country].length);
    if (c.prefixes && !c.prefixes.some((p) => national.startsWith(p))) {
      return fail("unsupported", `That number isn't on ${c.label.split(": ")[1]}. Check the number or choose another network.`);
    }
    return ok({ type: "mobile-money", phone: phone.value, name, network: c.network! });
  }

  const accountName = r.accountName.trim();
  const accountNumber = r.accountNumber.replace(/\s/g, "");
  if (!accountName || accountName.length > 100) return fail("unrecognised", "Enter the account holder's name as the bank has it.");
  if (!r.bankName.trim()) return fail("unrecognised", "Choose the recipient's bank.");
  if (c.country === "NG") {
    if (!/^\d{10}$/.test(accountNumber)) return fail("bad_encoding", "Nigerian account numbers have 10 digits.");
    if (!r.bankCode) return fail("unrecognised", "Choose the recipient's bank.");
  } else if (!/^\d{6,20}$/.test(accountNumber)) {
    return fail("bad_encoding", "That account number doesn't look right. Check it and try again.");
  }
  return ok({ ...r, accountName, accountNumber, bankName: r.bankName.trim() });
}

/** Checks a payout amount for its corridor: right currency, at most 2 decimals, at or above the minimum. */
export function validatePayoutAmount(corridorId: CorridorId, amount: Money): Result<Money> {
  const c = CORRIDORS[corridorId];
  if (amount.currency !== c.currency) return fail("unsupported", `${c.label} pays out in ${c.currency}.`);
  if (!isDecimal(amount.amount) || toScaled(amount.amount) === 0n) return fail("bad_amount", "Enter an amount greater than zero.");
  if ((amount.amount.split(".")[1]?.length ?? 0) > 2) return fail("bad_amount", `${c.currency} amounts can have at most 2 decimal places.`);
  if (c.minAmount && toScaled(amount.amount) < toScaled(c.minAmount)) {
    return fail("bad_amount", `The smallest ${c.label} payout is ${c.minAmount} ${c.currency}.`);
  }
  return ok({ amount: fromScaled(toScaled(amount.amount)), currency: c.currency });
}

/** Hides most of a phone or account number, for receipts and lists. */
export function maskRecipient(r: PayoutRecipient): string {
  if (r.type === "mobile-money") return `${r.name} (${r.phone.slice(0, 4)}••••${r.phone.slice(-3)})`;
  return `${r.accountName}, ${r.bankName} ••••${r.accountNumber.slice(-4)}`;
}

/** Machankura gives every registered phone number a Lightning Address: digits without "+", at 8333.mobi. */
export const machankuraAddress = (e164: string): string => `${e164.replace(/^\+/, "")}@8333.mobi`;
