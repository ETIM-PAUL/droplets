import { parseBolt11, type Bolt11Invoice } from "./bolt11";
import { parseEmvco, type EmvcoPayment } from "./emvco";
import { parseLightningAddress, type LightningAddress } from "./lightning-address";
import { parseLnurl, type Lnurl } from "./lnurl";
import { fail, type Result } from "./result";

export type ParsedPayment = Bolt11Invoice | Lnurl | LightningAddress | EmvcoPayment;

/** Works out what a pasted string or scanned QR is and parses it, all offline. */
export function parsePaymentInput(input: string): Result<ParsedPayment> {
  const s = input.trim().replace(/^lightning:/i, "");
  if (s === "") return fail("empty", "Nothing to read. Paste a payment request or scan a QR code.");

  if (/^ln(bcrt|bc|tbs|tb)\d*[munp]?1/i.test(s)) return parseBolt11(s);
  if (/^lnurl1/i.test(s) || /^(lnurlp|lnurlw|lnurlc|keyauth):\/\//i.test(s)) return parseLnurl(s);
  if (s.includes("@") && !s.includes(" ")) return parseLightningAddress(s);
  if (s.startsWith("000201")) return parseEmvco(s);

  return fail("unrecognised", "Errand can't read this yet. Try a Lightning invoice, a Lightning address or a payment QR code.");
}
