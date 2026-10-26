import { keccak_256 } from "@noble/hashes/sha3.js";
import { fail, ok, type Result } from "./result";

export interface EvmAddress {
  kind: "evm-address";
  /** EIP-55 checksummed. */
  address: string;
}

const HEX40 = /^0x[0-9a-fA-F]{40}$/;

export function toChecksumAddress(address: string): string {
  const lower = address.slice(2).toLowerCase();
  const hash = Array.from(keccak_256(new TextEncoder().encode(lower)), (b) => b.toString(16).padStart(2, "0")).join("");
  return "0x" + Array.from(lower, (c, i) => (parseInt(hash[i]!, 16) >= 8 ? c.toUpperCase() : c)).join("");
}

/** Accepts all-lowercase (no checksum to check) or EIP-55 mixed case, which must be correct: a bad case means a typo. */
export function parseEvmAddress(input: string): Result<EvmAddress> {
  const s = input.trim().replace(/^ethereum:/i, "");
  if (!HEX40.test(s)) return fail("unrecognised", "That isn't a valid wallet address. It should start with 0x and have 42 characters.");
  const body = s.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  const checksummed = toChecksumAddress(s);
  if (mixed && checksummed !== s) {
    return fail("bad_checksum", "This address has a typo: its capital letters don't match. Copy it again from the wallet.");
  }
  return ok({ kind: "evm-address", address: checksummed });
}
