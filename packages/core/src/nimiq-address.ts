import { fail, ok, type Result } from "./result";

/** Nimiq's base32 alphabet: no I, O, W or Z. */
const ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVXY";

/** IBAN-style check digits over the 32 address characters, as Nimiq computes them. */
function checkDigits(body: string): string {
  const numeric = (body + "NQ00")
    .split("")
    .map((c) => (/\d/.test(c) ? c : String(c.charCodeAt(0) - 55)))
    .join("");
  let rem = 0;
  for (let i = 0; i < numeric.length; i += 6) rem = Number(String(rem) + numeric.slice(i, i + 6)) % 97;
  return String(98 - rem).padStart(2, "0");
}

/**
 * Checks a Nimiq address ("NQ07 0000 …") and returns it in the grouped form wallets show.
 * A typo fails the checksum, so NIM is never sent to an address nobody owns.
 */
export function parseNimiqAddress(input: string): Result<string> {
  const s = input.replace(/\s+/g, "").toUpperCase();
  if (!/^NQ\d{2}/.test(s) || s.length !== 36) return fail("unrecognised", "That isn't a Nimiq address. It should start with NQ and have 36 characters.");
  const body = s.slice(4);
  if ([...body].some((c) => !ALPHABET.includes(c))) return fail("bad_encoding", "That Nimiq address has a character that can't be in one. Copy it again.");
  if (checkDigits(body) !== s.slice(2, 4)) return fail("bad_checksum", "That Nimiq address has a typo. Copy it again from Nimiq Pay.");
  return ok(s.match(/.{4}/g)!.join(" "));
}

/** The 20 address bytes in the grouped form wallets show. */
export function formatNimiqAddress(bytes: Uint8Array): string {
  if (bytes.length !== 20) throw new RangeError("A Nimiq address is 20 bytes.");
  let bits = 0;
  let value = 0;
  let body = "";
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      body += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `NQ${checkDigits(body)}${body}`.match(/.{4}/g)!.join(" ");
}

/** The 20 bytes behind a valid address, as they appear in transaction data (an add-stake names its staker this way). */
export function nimiqAddressBytes(address: string): Uint8Array {
  const parsed = parseNimiqAddress(address);
  if (!parsed.ok) throw new RangeError(parsed.error.message);
  const body = parsed.value.replace(/\s+/g, "").slice(4);
  const out = new Uint8Array(20);
  let bits = 0;
  let value = 0;
  let i = 0;
  for (const c of body) {
    value = ((value << 5) | ALPHABET.indexOf(c)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out[i++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return out;
}
