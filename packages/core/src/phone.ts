import { fail, ok, type Result } from "./result";

export type CountryCode = "KE" | "NG" | "GH" | "ZA";

export const CALLING_CODE: Record<CountryCode, string> = { KE: "254", NG: "234", GH: "233", ZA: "27" };
/** Digits after the calling code for a mobile number. */
const NATIONAL_LENGTH: Record<CountryCode, number> = { KE: 9, NG: 10, GH: 9, ZA: 9 };

/**
 * Normalises what people actually type ("0712 345 678", "254712345678", "+254-712-345678")
 * to E.164 ("+254712345678") for the given country.
 */
export function normalizePhone(input: string, country: CountryCode): Result<string> {
  const code = CALLING_CODE[country];
  const digits = input.replace(/[\s\-().]/g, "");
  if (!/^\+?\d+$/.test(digits)) return fail("unrecognised", "A phone number can only contain digits, spaces and a leading +.");

  let national: string;
  if (digits.startsWith("+")) {
    if (!digits.startsWith("+" + code)) return fail("unsupported", `This number isn't a ${country} number. It should start with +${code}.`);
    national = digits.slice(1 + code.length);
  } else if (digits.startsWith(code) && digits.length === code.length + NATIONAL_LENGTH[country]) {
    national = digits.slice(code.length);
  } else if (digits.startsWith("0")) {
    national = digits.slice(1);
  } else {
    national = digits;
  }

  if (national.length !== NATIONAL_LENGTH[country]) {
    return fail("bad_encoding", `That number has the wrong number of digits for ${country}. Check it and try again.`);
  }
  return ok(`+${code}${national}`);
}
