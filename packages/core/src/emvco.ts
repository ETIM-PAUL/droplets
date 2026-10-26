import { fail, ok, type Result } from "./result";

export interface EmvcoMerchantAccount {
  /** Top-level tag, 26 to 51. */
  tag: string;
  /** Globally unique identifier (sub-tag 00), e.g. a scheme domain or AID. */
  scheme: string | null;
  fields: Record<string, string>;
}

export interface EmvcoPayment {
  kind: "emvco";
  initiation: "static" | "dynamic" | null;
  merchantName: string | null;
  merchantCity: string | null;
  countryCode: string | null;
  merchantCategoryCode: string | null;
  /** ISO 4217 numeric code, e.g. "404" for KES. */
  currencyNumeric: string | null;
  /** Decimal string exactly as encoded; null when the payer enters the amount. */
  amount: string | null;
  merchantAccounts: EmvcoMerchantAccount[];
  /** Raw top-level tags, for fields we don't interpret. */
  tags: Record<string, string>;
}

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, as used by EMVCo QR. */
export function crc16(data: string): string {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(data)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function readTlv(s: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < s.length) {
    const tag = s.slice(i, i + 2);
    const lenStr = s.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lenStr)) return null;
    const len = Number(lenStr);
    const value = s.slice(i + 4, i + 4 + len);
    if (value.length !== len) return null;
    if (tag in out) return null;
    out[tag] = value;
    i += 4 + len;
  }
  return out;
}

export function parseEmvco(input: string): Result<EmvcoPayment> {
  const s = input.trim();
  if (!s.startsWith("000201")) return fail("unrecognised", "This isn't a payment QR code Errand understands.");

  const crcAt = s.length - 8;
  if (crcAt < 0 || s.slice(crcAt, crcAt + 4) !== "6304") {
    return fail("bad_encoding", "This QR code is incomplete. Scan it again.");
  }
  if (crc16(s.slice(0, crcAt + 4)) !== s.slice(crcAt + 4).toUpperCase()) {
    return fail("bad_checksum", "This QR code is damaged or has been altered. Scan it again, or ask the merchant for a new one.");
  }

  const tags = readTlv(s);
  if (!tags) return fail("bad_encoding", "This QR code can't be read. Scan it again.");

  const amount = tags["54"] ?? null;
  if (amount !== null && !/^\d+(\.\d{1,8})?$/.test(amount)) {
    return fail("bad_amount", "The amount in this QR code is invalid. Ask the merchant for a new one.");
  }

  const merchantAccounts: EmvcoMerchantAccount[] = [];
  for (let t = 26; t <= 51; t++) {
    const tag = String(t).padStart(2, "0");
    const raw = tags[tag];
    if (raw === undefined) continue;
    const fields = readTlv(raw) ?? {};
    merchantAccounts.push({ tag, scheme: fields["00"] ?? null, fields });
  }

  const initiation = tags["01"] === "11" ? "static" : tags["01"] === "12" ? "dynamic" : null;

  return ok({
    kind: "emvco",
    initiation,
    merchantName: tags["59"] ?? null,
    merchantCity: tags["60"] ?? null,
    countryCode: tags["58"] ?? null,
    merchantCategoryCode: tags["52"] ?? null,
    currencyNumeric: tags["53"] ?? null,
    amount,
    merchantAccounts,
    tags,
  });
}
