import { msatToSats } from "./bolt11";
import { CORRIDORS } from "./corridors";
import type { PayIntent, Quote } from "./engine/types";
import { groupDigits } from "./money";
import type { ParsedPayment } from "./parse";

/** ISO 4217 numeric codes seen in EMVCo QRs in the countries Droplets serves. */
const CURRENCY_NUMERIC: Record<string, string> = { "404": "KES", "566": "NGN", "936": "GHS", "710": "ZAR", "840": "USD", "978": "EUR" };

const sats = (s: string) => `${groupDigits(s)} sats`;

function inMinutes(seconds: number): string {
  if (seconds < 90) return "about a minute";
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} minutes`;
  const h = Math.round(seconds / 3600);
  return h === 1 ? "about an hour" : `about ${h} hours`;
}

/** Who or what the money goes to, in a few words: for the order screen, the list and receipts. */
export function destinationLabel(d: PayIntent["destination"]): string {
  switch (d.kind) {
    case "fiat-payout": return d.recipient.type === "mobile-money" ? d.recipient.name : d.recipient.accountName;
    case "airtime": return d.phone;
    case "bolt11": return d.description?.trim().slice(0, 40) || "a Lightning invoice";
    case "lightning-address": return `${d.user}@${d.domain}`;
    case "lnurl": {
      try {
        return new URL(d.url).hostname;
      } catch {
        return "a Lightning payment link";
      }
    }
    case "evm-address": return `${d.address.slice(0, 6)}…${d.address.slice(-4)}`;
    case "emvco": return d.merchantName ?? "a merchant";
  }
}

export interface PaymentSummary {
  /** One line: what this is. */
  title: string;
  /** Plain facts, one per line. */
  details: string[];
  /** Whether Droplets can pay it today; when not, `why` says so plainly. */
  payable: boolean;
  why?: string;
  /** For amountless requests: the unit the amount is asked in. */
  needsAmount?: "SAT";
}

/** Says in plain words what a scanned or pasted payment request is, before anything is quoted. */
export function describePayment(p: ParsedPayment, nowMs: number, hostNetwork: "mainnet" | "testnet"): PaymentSummary {
  switch (p.kind) {
    case "bolt11": {
      const details: string[] = [];
      if (p.description) details.push(`For: "${p.description.slice(0, 120)}"`);
      const left = p.expiresAt - Math.floor(nowMs / 1000);
      details.push(left > 0 ? `Expires in ${inMinutes(left)}.` : "This invoice has expired.");
      const wanted = hostNetwork === "mainnet" ? "mainnet" : "testnet";
      const base = { title: p.amountMsat ? `A Lightning invoice for ${sats(msatToSats(p.amountMsat))}` : "A Lightning invoice with no amount", details };
      if (p.network !== wanted) return { ...base, payable: false, why: `It's for bitcoin ${p.network}, but Nimiq Pay is on ${hostNetwork}.` };
      if (left <= 0) return { ...base, payable: false, why: "Ask the recipient for a new invoice." };
      if (!p.amountMsat) return { ...base, payable: false, why: "Ask the recipient for an invoice with an amount in it." };
      return { ...base, payable: true };
    }
    case "lightning-address":
      return {
        title: `A Lightning Address: ${p.user}@${p.domain}`,
        details: ["You choose how much to send. Droplets asks their service for an invoice and checks it before you pay."],
        payable: true,
        needsAmount: "SAT",
      };
    case "lnurl": {
      const host = destinationLabel(p);
      return {
        title: `A Lightning payment link from ${host}`,
        details: ["You choose how much to send. Droplets asks the service for an invoice and checks it before you pay."],
        payable: true,
        needsAmount: "SAT",
      };
    }
    case "evm-address":
      return {
        title: `A wallet address: ${destinationLabel(p)}`,
        details: ["An address on Ethereum or a network like it, such as Polygon. The QR doesn't say which network."],
        payable: false,
        why: "Paying wallet addresses from the Droplets home screen is coming. Check the network with the recipient first.",
      };
    case "emvco": {
      const currency = p.currencyNumeric ? CURRENCY_NUMERIC[p.currencyNumeric] ?? `currency ${p.currencyNumeric}` : null;
      const details = [
        [p.merchantName, p.merchantCity].filter(Boolean).join(", "),
        p.amount ? `Amount: ${groupDigits(p.amount)}${currency ? ` ${currency}` : ""}` : "The amount is entered at payment.",
      ].filter(Boolean);
      return {
        title: `A shop's payment QR${p.merchantName ? ` for ${p.merchantName}` : ""}`,
        details,
        payable: false,
        why: "Droplets can't pay shop QR codes yet. That's coming in a later update.",
      };
    }
  }
}

/**
 * The route advisor: how a quote moves the money, step by step, in plain words. Built from the quote
 * itself (route, steps, amounts), never from a model, so it can't say anything the quote doesn't.
 */
export function explainRoute(q: Quote): string[] {
  const d = q.intent.destination;
  const eta = inMinutes(q.etaSeconds);
  const pay = "You approve the payment in Nimiq Pay. It swaps your NIM or USDT to bitcoin and pays over the Lightning network.";
  switch (q.routeId) {
    case "fiat-payout": {
      if (d.kind !== "fiat-payout") break;
      const c = CORRIDORS[d.corridor];
      const where = d.recipient.type === "mobile-money" ? `${d.recipient.name}'s ${c.label.split(": ")[1]}` : `${d.recipient.accountName}'s ${d.recipient.bankName} account`;
      return [
        pay,
        `Mavapay receives the bitcoin, turns it into ${c.currency}, and pays ${groupDigits(q.receive.amount)} ${c.currency} into ${where}.`,
        `Usually arrives in ${eta}. Droplets never holds your money at any point.`,
      ];
    }
    case "airtime":
      return [pay, `Bitrefill receives it and tops up ${destinationLabel(d)} with ${groupDigits(q.receive.amount)} ${q.receive.currency} of airtime.`, `Usually arrives in ${eta}.`];
    case "lnurl-pay":
      return [pay, `The bitcoin goes straight to ${destinationLabel(d)}. No one else holds it on the way.`, `Usually arrives in ${eta}.`];
    case "lightning-invoice":
      return [pay, `The bitcoin goes straight to whoever made the invoice${d.kind === "bolt11" && d.description ? ` ("${d.description.slice(0, 60)}")` : ""}.`, "Lightning payments usually arrive within seconds."];
    case "lendaswap-exit":
      return [pay, `LendaSwap turns it into ${q.receive.currency} and delivers it to ${destinationLabel(d)}.`, `Usually arrives in ${eta}.`];
  }
  return [pay, `Usually arrives in ${eta}.`];
}
