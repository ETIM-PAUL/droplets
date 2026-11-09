import { bech32 } from "@scure/base";
import { fail, ok, type Result } from "./result";

export interface Lnurl {
  kind: "lnurl";
  /** The service URL to fetch; its response says what kind of LNURL it is. */
  url: string;
}

const SCHEMES = /^(lnurlp|lnurlw|lnurlc|keyauth):\/\//i;

function checkUrl(url: string): Result<Lnurl> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return fail("bad_encoding", "This LNURL doesn't contain a valid link. Ask for a new one.");
  }
  const onion = u.hostname.endsWith(".onion");
  if (u.protocol !== "https:" && !(onion && u.protocol === "http:")) {
    return fail("unsupported", "This LNURL points to an insecure link, so Droplets won't use it.");
  }
  return ok({ kind: "lnurl", url: u.toString() });
}

export function parseLnurl(input: string): Result<Lnurl> {
  const s = input.trim().replace(/^lightning:/i, "");

  if (SCHEMES.test(s)) {
    const onion = /^[^/]*\.onion/i.test(s.replace(SCHEMES, ""));
    return checkUrl(s.replace(SCHEMES, onion ? "http://" : "https://"));
  }

  try {
    const { prefix, words } = bech32.decode(s.toLowerCase(), false);
    if (prefix !== "lnurl") return fail("unrecognised", "This isn't an LNURL.");
    return checkUrl(new TextDecoder("utf-8", { fatal: true }).decode(bech32.fromWords(words)));
  } catch {
    return fail("bad_checksum", "This LNURL looks incomplete or damaged. Copy it again in full and retry.");
  }
}

export const encodeLnurl = (url: string): string =>
  bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode(url)), false).toUpperCase();
