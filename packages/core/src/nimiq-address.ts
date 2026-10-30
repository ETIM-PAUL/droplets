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
