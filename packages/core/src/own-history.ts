// A Nimiq Pay user's own accounts and what they did with them. Nimiq Pay keeps the spendable balance in an HTLC it
// co-signs, funded from the user's wallet address and replaced about once a week, and it sends payments and staking
// transactions from that HTLC. So the wallet address's own history misses most of what the user does: their own
// accounts are the wallet plus every HTLC it funded.
import { addressKey } from "./nimiq-address";
import type { NimiqTransaction } from "./nimiq-rpc";
import { STAKING_CONTRACT } from "./save";

/** Nimiq Pay's HTLCs time out after 14 days, so one funded longer ago than this has no activity left to read. */
export const HTLC_LIFETIME_DAYS = 15;
/** Recipient account type 2, and flag 1: the transaction creates the HTLC it pays into. */
const createsHtlc = (t: NimiqTransaction) => t.toType === 2 && ((t.flags ?? 0) & 1) === 1;
/** HTLC histories read at the same time. */
const PARALLEL = 6;

export interface OwnHistory {
  wallet: string;
  /** The HTLCs the wallet funded, newest first. */
  htlcs: string[];
  /** Every transaction to or from the wallet or one of those HTLCs, once each, newest first. */
  txs: NimiqTransaction[];
  /** False when an account had more transactions than were read, back to `need`, so some may be missing. */
  complete: boolean;
  /** Everything after this is known to be read: the latest point an account's reads stopped at, or 0 if none stopped. */
  coversFrom: number;
}

/**
 * Reads the wallet's history, then each HTLC it funded since `since`. An HTLC that one of those creates in turn is
 * a swap, such as a Lightning payment, so it's money leaving, not another of the user's accounts. `read` returns an
 * address's latest `max` transactions. The history is complete if every account's reads reach back to `need`.
 */
export async function ownHistory(
  wallet: string,
  read: (address: string, max: number) => Promise<NimiqTransaction[]>,
  o: { since: number; need?: number; max?: number; maxHtlcs?: number },
): Promise<OwnHistory> {
  const max = o.max ?? 500;
  const need = o.need ?? o.since;
  let coversFrom = 0;
  // An account read in full covers all time; one cut short covers back to its oldest transaction read.
  const reached = (txs: NimiqTransaction[]) => void (txs.length >= max && (coversFrom = Math.max(coversFrom, Math.min(...txs.map((t) => t.timestamp)))));

  const walletTxs = await read(wallet, max);
  reached(walletTxs);
  let complete = true;
  const funded = walletTxs.filter((t) => t.executionResult && addressKey(t.from) === addressKey(wallet) && createsHtlc(t) && t.timestamp >= o.since);
  const htlcs = [...new Set(funded.map((t) => t.to))];
  if (htlcs.length > (o.maxHtlcs ?? 200)) {
    complete = false;
    htlcs.length = o.maxHtlcs ?? 200;
  }

  const byHash = new Map(walletTxs.map((t) => [t.hash, t]));
  for (let i = 0; i < htlcs.length; i += PARALLEL) {
    for (const txs of await Promise.all(htlcs.slice(i, i + PARALLEL).map((a) => read(a, max)))) {
      reached(txs);
      for (const t of txs) byHash.set(t.hash, t);
    }
  }
  return { wallet, htlcs, txs: [...byHash.values()].sort((a, b) => b.timestamp - a.timestamp), complete: complete && coversFrom <= need, coversFrom };
}

/** The wallet and its HTLCs, for checking whether a transaction is the user's own. */
export const ownAddresses = (h: Pick<OwnHistory, "wallet" | "htlcs">): Set<string> => new Set([h.wallet, ...h.htlcs].map(addressKey));
export const isOwn = (own: Set<string>, address: string) => own.has(addressKey(address));

/**
 * Luna the user spent in [from, to): everything that left their own accounts, except moves between them (the
 * wallet funding its HTLC, an HTLC handing the rest back) and staking, which is saving. A Lightning payment counts
 * when it leaves, as the swap HTLC it starts.
 */
export function spentBetween(h: Pick<OwnHistory, "wallet" | "htlcs" | "txs">, from: number, to: number): bigint {
  const own = ownAddresses(h);
  let spent = 0n;
  for (const t of h.txs) {
    if (!t.executionResult || t.timestamp < from || t.timestamp >= to) continue;
    if (isOwn(own, t.from) && !isOwn(own, t.to) && addressKey(t.to) !== addressKey(STAKING_CONTRACT)) spent += t.value;
  }
  return spent;
}
