// Errand Save, phase 1: save codes, the signed rule behind them, and how a payment splits between
// the user's wallet and their Grow savings (their own staked NIM). Pure functions, shared by the API,
// the payout SDK and the Mini App.
import { blake2b } from "@noble/hashes/blake2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { formatNimiqAddress, parseNimiqAddress } from "./nimiq-address";
import { fail, ok, type Result } from "./result";

// ---- Save codes: 6 random characters and a check character, written SAVE-7KQ2XMP.

/** Crockford base32: no I, L, O or U, so a code survives being read aloud or copied by hand. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_BODY = 6;

/** Luhn mod 32 over the code alphabet: catches any single typo and most swapped neighbours. */
function checkCharacter(body: string): string {
  let factor = 2;
  let sum = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    let addend = factor * CODE_ALPHABET.indexOf(body[i]!);
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / 32) + (addend % 32);
    sum += addend;
  }
  return CODE_ALPHABET[(32 - (sum % 32)) % 32]!;
}

/** A new random code, without the SAVE- prefix. */
export function newSaveCode(random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  // 256 is a multiple of 32, so masking a byte keeps every character equally likely.
  const body = [...random(CODE_BODY)].map((b) => CODE_ALPHABET[b & 31]).join("");
  return body + checkCharacter(body);
}

export const formatSaveCode = (code: string): string => `SAVE-${code}`;

/**
 * Reads a save code however it was typed: "SAVE-7KQ2XMP", "save 7kq2xmp" or "7KQ2XMP".
 * O reads as 0 and I or L as 1, as Crockford base32 intends. Returns the 7 characters without the prefix.
 */
export function parseSaveCode(input: string): Result<string> {
  let s = input.trim().toUpperCase().replace(/[\s-]/g, "");
  if (s.length === CODE_BODY + 5 && s.startsWith("SAVE")) s = s.slice(4);
  s = s.replace(/O/g, "0").replace(/[IL]/g, "1");
  if (s.length !== CODE_BODY + 1 || [...s].some((c) => !CODE_ALPHABET.includes(c))) {
    return fail("unrecognised", "That isn't a save code. Save codes look like SAVE-7KQ2XMP.");
  }
  if (checkCharacter(s.slice(0, CODE_BODY)) !== s.slice(CODE_BODY)) return fail("bad_checksum", "That save code has a typo. Check it and try again.");
  return ok(s);
}

// ---- The rule, signed by the user in Nimiq Pay.

export interface SaveRuleMessage {
  action: "set" | "revoke";
  address: string;
  /** Whole percent of each payment that goes to savings. Only for "set". */
  savePercent?: number;
  /** ISO 8601 UTC, e.g. 2026-11-04T15:20:00.000Z. */
  time: string;
  /** 16 to 64 hex characters, never reused. */
  nonce: string;
}

const MESSAGE_TITLE = "Errand save code";

/** The exact text the user signs. One field per line, so what Nimiq Pay shows is what we check. */
export function formatSaveMessage(m: SaveRuleMessage): string {
  const lines = [MESSAGE_TITLE, `Action: ${m.action}`, `Address: ${m.address}`];
  if (m.action === "set") lines.push(`Save: ${m.savePercent}%`);
  lines.push(`Time: ${m.time}`, `Nonce: ${m.nonce}`);
  return lines.join("\n");
}

/** Reads a signed rule. Anything but the exact format formatSaveMessage writes is refused. */
export function parseSaveMessage(text: string): Result<SaveRuleMessage> {
  const bad = fail("unrecognised", "That isn't an Errand save message.");
  const lines = text.split("\n");
  if (lines[0] !== MESSAGE_TITLE) return bad;
  const field = (i: number, name: string) => (lines[i]?.startsWith(`${name}: `) ? lines[i]!.slice(name.length + 2) : null);
  const action = field(1, "Action");
  if (action !== "set" && action !== "revoke") return bad;
  const address = parseNimiqAddress(field(2, "Address") ?? "");
  if (!address.ok) return bad;
  let i = 3;
  let savePercent: number | undefined;
  if (action === "set") {
    const pct = /^(\d{1,3})%$/.exec(field(i++, "Save") ?? "");
    savePercent = pct ? Number(pct[1]) : NaN;
    if (!Number.isInteger(savePercent) || savePercent < 0 || savePercent > 100) return fail("bad_amount", "The share to save must be a whole percent from 0 to 100.");
  }
  const time = field(i++, "Time") ?? "";
  const nonce = field(i++, "Nonce") ?? "";
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/.test(time) || Number.isNaN(Date.parse(time))) return bad;
  if (!/^[0-9a-f]{16,64}$/.test(nonce) || lines.length !== i) return bad;
  const m: SaveRuleMessage = { action, address: address.value, ...(action === "set" ? { savePercent } : {}), time, nonce };
  // Round trip: refuses extra spaces, a lowercase address or anything else that reads differently from what was signed.
  return formatSaveMessage(m) === text ? ok(m) : bad;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/** What Nimiq Pay's sign() signs: SHA-256 of "\x16Nimiq Signed Message:\n" + byte length + the message. */
export function nimiqMessageHash(message: string): Uint8Array {
  const body = utf8(message);
  const prefix = utf8(`\x16Nimiq Signed Message:\n${body.length}`);
  const payload = new Uint8Array(prefix.length + body.length);
  payload.set(prefix);
  payload.set(body, prefix.length);
  return sha256(payload);
}

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));

/** The Nimiq address of an Ed25519 public key: the first 20 bytes of its BLAKE2b-256 hash. */
export function nimiqAddressFromPublicKey(publicKeyHex: string): string {
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) throw new RangeError("A Nimiq public key is 32 bytes of hex.");
  return formatNimiqAddress(blake2b(fromHex(publicKeyHex), { dkLen: 32 }).slice(0, 20));
}

// ---- Grow: the user's own stake, and how a payment splits into it.

/** Protocol minimum: a staker's active plus inactive balance is 0 or at least 100 NIM. */
export const MIN_STAKE_LUNA = 10_000_000n;
export const LUNA_PER_NIM = 100_000n;
/** Nimiq mainnet and testnet: 43,200 one-second blocks per epoch. */
export const BLOCKS_PER_EPOCH = 43_200;
export const JAIL_EPOCHS = 8;
export const STAKING_CONTRACT = "NQ77 0000 0000 0000 0000 0000 0000 0000 0001";

export interface StakerState {
  /** Luna, earning. */
  active: bigint;
  /** Luna, on its way out. */
  inactive: bigint;
  /** The election block the inactive stake's lock-up runs from; null when nothing is inactive. */
  inactiveFrom: number | null;
  /** Luna, ready to remove. */
  retired: bigint;
  delegation: string;
}

export type GrowState = { open: true; staker: StakerState } | { open: false; reason: "no-stake" | "validator-gone" };

export interface SaveSplit {
  wallet: bigint;
  grow: bigint;
  /** Why nothing went to Grow when the rule asked for some. */
  reason: null | "no-stake" | "validator-gone" | "below-minimum";
}

/**
 * Splits a payment in luna. Grow gets floor(amount × percent / 100) and the wallet the rest.
 * When Grow can't take it (no stake, the validator is gone, or the stake would end up under the
 * 100 NIM minimum) the whole payment goes to the wallet, so a payout never fails because of savings.
 */
export function splitPayout(luna: bigint, savePercent: number, grow: GrowState): SaveSplit {
  if (luna <= 0n) throw new RangeError("A payment must be more than 0 luna.");
  if (!Number.isInteger(savePercent) || savePercent < 0 || savePercent > 100) throw new RangeError("savePercent must be a whole number from 0 to 100.");
  const part = (luna * BigInt(savePercent)) / 100n;
  if (part === 0n) return { wallet: luna, grow: 0n, reason: null };
  if (!grow.open) return { wallet: luna, grow: 0n, reason: grow.reason };
  if (grow.staker.active + grow.staker.inactive + part < MIN_STAKE_LUNA) return { wallet: luna, grow: 0n, reason: "below-minimum" };
  return { wallet: luna - part, grow: part, reason: null };
}

/** First block at which inactive stake can be retired: one epoch after its lock-up starts, and after any jail ends. */
export function releaseBlock(inactiveFrom: number, validatorJailedFrom: number | null = null): number {
  const lockup = inactiveFrom + BLOCKS_PER_EPOCH + 1;
  const jail = validatorJailedFrom === null ? 0 : validatorJailedFrom + BLOCKS_PER_EPOCH * JAIL_EPOCHS + 1;
  return Math.max(lockup, jail);
}

/** Checks a withdrawal from active stake: what stays behind must be 0 or at least 100 NIM. */
export function checkWithdrawal(staker: StakerState, luna: bigint): Result<{ newActive: bigint }> {
  if (luna <= 0n) return fail("bad_amount", "Enter an amount to withdraw.");
  if (luna > staker.active) return fail("bad_amount", "That's more than you have in Grow.");
  const left = staker.active + staker.inactive - luna;
  if (left !== 0n && left < MIN_STAKE_LUNA) return fail("bad_amount", "Leave at least 100 NIM in Grow, or withdraw all of it.");
  return ok({ newActive: staker.active - luna });
}

/** Whole luna to a decimal NIM string, never through floats. */
export function lunaToNimString(luna: bigint): string {
  const whole = luna / LUNA_PER_NIM;
  const frac = (luna % LUNA_PER_NIM).toString().padStart(5, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** A decimal NIM string to whole luna. Up to 5 decimals. */
export function nimStringToLuna(amount: string): Result<bigint> {
  const m = /^(\d{1,12})(?:\.(\d{1,5}))?$/.exec(amount.trim());
  if (!m) return fail("bad_amount", "Enter an amount in NIM, with up to 5 decimal places.");
  return ok(BigInt(m[1]!) * LUNA_PER_NIM + BigInt((m[2] ?? "").padEnd(5, "0")));
}
