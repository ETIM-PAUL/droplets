import { bech32 } from "@scure/base";
import { fail, ok, type Result } from "./result";

export type LightningNetwork = "mainnet" | "testnet" | "signet" | "regtest";

export interface Bolt11Invoice {
  kind: "bolt11";
  network: LightningNetwork;
  /** Millisatoshis as a decimal string, or null for an amountless invoice. */
  amountMsat: string | null;
  /** Unix seconds. */
  timestamp: number;
  /** Seconds after the timestamp; 3600 when the invoice carries no expiry tag. */
  expirySeconds: number;
  /** Unix seconds. */
  expiresAt: number;
  paymentHash: string;
  description: string | null;
  descriptionHash: string | null;
  payeePubkey: string | null;
  minFinalCltvExpiry: number | null;
  /** The invoice as given, lowercased. */
  raw: string;
}

const PREFIXES: Record<string, LightningNetwork> = {
  bc: "mainnet",
  tb: "testnet",
  tbs: "signet",
  bcrt: "regtest",
};

const DEFAULT_EXPIRY_SECONDS = 3600;
const SIGNATURE_WORDS = 104;
const TIMESTAMP_WORDS = 7;
const HEX = "0123456789abcdef";

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => HEX[b >> 4]! + HEX[b & 15]!).join("");
const wordsToInt = (words: number[]) => words.reduce((n, w) => n * 32 + w, 0);

/** BOLT11 amount (HRP digits plus optional m/u/n/p multiplier) to millisatoshis. */
export function amountToMsat(digits: string, multiplier: string): string | null {
  if (digits === "") return null;
  if (digits.length > 1 && digits.startsWith("0")) return null;
  const n = BigInt(digits);
  switch (multiplier) {
    case "":
      return (n * 100_000_000_000n).toString();
    case "m":
      return (n * 100_000_000n).toString();
    case "u":
      return (n * 100_000n).toString();
    case "n":
      return (n * 100n).toString();
    case "p":
      // 1 pico-BTC is 0.1 msat; the spec requires a multiple of 10.
      return n % 10n === 0n ? (n / 10n).toString() : null;
    default:
      return null;
  }
}

export function parseBolt11(input: string): Result<Bolt11Invoice> {
  const raw = input.trim().toLowerCase();
  let decoded;
  try {
    decoded = bech32.decode(raw, false);
  } catch {
    return fail("bad_checksum", "This doesn't look like a complete Lightning invoice. Copy it again in full and retry.");
  }

  const hrp = /^ln(bcrt|bc|tbs|tb)(\d*)([munp]?)$/.exec(decoded.prefix);
  if (!hrp) return fail("unrecognised", "This isn't a Lightning invoice.");
  const network = PREFIXES[hrp[1]!]!;
  const digits = hrp[2]!;
  const multiplier = hrp[3]!;

  const amountMsat = amountToMsat(digits, multiplier);
  if (digits !== "" && amountMsat === null) {
    return fail("bad_amount", "The amount in this invoice is invalid. Ask the sender for a new invoice.");
  }
  if (multiplier !== "" && digits === "") {
    return fail("bad_amount", "The amount in this invoice is invalid. Ask the sender for a new invoice.");
  }

  const words = decoded.words;
  if (words.length < TIMESTAMP_WORDS + SIGNATURE_WORDS) {
    return fail("bad_encoding", "This invoice is too short to be valid. Ask the sender for a new one.");
  }
  const timestamp = wordsToInt(words.slice(0, TIMESTAMP_WORDS));
  const body = words.slice(TIMESTAMP_WORDS, words.length - SIGNATURE_WORDS);

  let paymentHash: string | null = null;
  let description: string | null = null;
  let descriptionHash: string | null = null;
  let payeePubkey: string | null = null;
  let expirySeconds = DEFAULT_EXPIRY_SECONDS;
  let minFinalCltvExpiry: number | null = null;

  try {
    for (let i = 0; i < body.length; ) {
      if (i + 3 > body.length) throw new Error("truncated field header");
      const type = body[i]!;
      const len = body[i + 1]! * 32 + body[i + 2]!;
      const data = body.slice(i + 3, i + 3 + len);
      if (data.length !== len) throw new Error("truncated field");
      i += 3 + len;

      switch (type) {
        case 1: // p: payment hash
          if (len === 52) paymentHash = hex(bech32.fromWords(data));
          break;
        case 13: // d: description
          description = new TextDecoder("utf-8", { fatal: true }).decode(bech32.fromWords(data));
          break;
        case 23: // h: description hash
          if (len === 52) descriptionHash = hex(bech32.fromWords(data));
          break;
        case 19: // n: payee public key
          if (len === 53) payeePubkey = hex(bech32.fromWords(data));
          break;
        case 6: // x: expiry
          expirySeconds = wordsToInt(data);
          break;
        case 24: // c: min_final_cltv_expiry_delta
          minFinalCltvExpiry = wordsToInt(data);
          break;
        default:
          break; // unknown and optional fields (secret, features, routes) are skipped
      }
    }
  } catch {
    return fail("bad_encoding", "This invoice is damaged and can't be read. Ask the sender for a new one.");
  }

  if (!paymentHash) {
    return fail("bad_encoding", "This invoice has no payment hash and can't be paid. Ask the sender for a new one.");
  }

  return ok({
    kind: "bolt11",
    network,
    amountMsat,
    timestamp,
    expirySeconds,
    expiresAt: timestamp + expirySeconds,
    paymentHash,
    description,
    descriptionHash,
    payeePubkey,
    minFinalCltvExpiry,
    raw,
  });
}

export const isExpired = (invoice: Bolt11Invoice, nowSeconds = Math.floor(Date.now() / 1000)) =>
  nowSeconds >= invoice.expiresAt;

/** Msat decimal string to a sats decimal string, keeping any sub-sat fraction. */
export function msatToSats(msat: string): string {
  const m = BigInt(msat);
  const whole = m / 1000n;
  const frac = (m % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
