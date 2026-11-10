// @droplets/save: pay rewards into a user's savings, by save code or by the address you already pay, and save a
// share on top when users pay you. Server-side: the app key is a secret. Building and sending payments is in
// "@droplets/save/payer"; this entry only talks to the Droplets API.
// createNimiqRpc is the node client the payer needs, so apps needn't install anything else for it.
export { createNimiqRpc, formatSaveCode, parseSaveCode } from "@railkit/core";
export type { NimiqRpc } from "@railkit/core";

export class SaveApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface SaveSplit {
  /** The code, when you paid one; null when you paid an address. */
  code: string | null;
  address: string;
  savePercent: number;
  /** Luna for a normal payment to the user's address. */
  walletLuna: bigint;
  /** Luna for an add-stake into the user's Grow savings; 0n when nothing goes there. */
  growLuna: bigint;
  /** The address whose stake receives growLuna (the user's own). */
  staker: string;
  /** Why Grow got nothing when the rule asked for some. */
  reason: null | "no-stake" | "validator-gone" | "below-minimum";
}

/**
 * Spend and save: what to charge a user who pays you. Ask for totalLuna; once it arrives, put saveLuna into their
 * stake with the payer's saveFromSpend(). Users who haven't allowed your app get saveLuna 0n, like everyone else.
 */
export interface SpendQuote {
  address: string;
  spendPercent: number;
  /** Your price. */
  priceLuna: bigint;
  /** Added on top, for the user's savings; 0n when nothing is. */
  saveLuna: bigint;
  /** What to ask the user to pay: priceLuna + saveLuna. */
  totalLuna: bigint;
  /** Why nothing is saved when the user's rule asked for some. */
  reason: SaveSplit["reason"];
}

export type ReceiptStatus = "recorded" | "pending";

export interface SaveApiOptions {
  /** e.g. https://api.errand.example */
  apiUrl: string;
  /** rk_save_…, issued by Droplets. Keep it on your server. */
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createSaveApi(o: SaveApiOptions) {
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = o.apiUrl.replace(/\/$/, "");

  async function call<T>(path: string, init?: RequestInit, timeoutMs = o.timeoutMs ?? 15_000): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(base + path, {
        ...init,
        headers: { ...(init?.headers as Record<string, string> | undefined), Authorization: `Bearer ${o.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new SaveApiError("Couldn't reach the Droplets API.", 0);
    }
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!res.ok) throw new SaveApiError(body?.error?.message ?? `Droplets API answered ${res.status}`, res.status);
    return body as T;
  }

  type SplitReply = { code: string | null; address: string; savePercent: number; wallet: { luna: string }; grow: { luna: string; staker: string } | null; reason: SaveSplit["reason"] };
  const toSplit = (r: SplitReply): SaveSplit => ({
    code: r.code, address: r.address, savePercent: r.savePercent, walletLuna: BigInt(r.wallet.luna),
    growLuna: r.grow ? BigInt(r.grow.luna) : 0n, staker: r.grow?.staker ?? r.address, reason: r.reason,
  });
  const payout = (payoutId?: string) => (payoutId ? `&payoutId=${encodeURIComponent(payoutId)}` : "");

  return {
    /**
     * How to split `luna` for this code. Throws SaveApiError 404 when the code isn't active.
     * Pass the payoutId: Droplets keeps the split, so the user can ask why a payment went to their wallet.
     */
    split: async (code: string, luna: bigint, payoutId?: string): Promise<SaveSplit> =>
      toSplit(await call<SplitReply>(`/v1/save/split?code=${encodeURIComponent(code)}&luna=${luna}${payout(payoutId)}`)),
    /**
     * How to split `luna` for an address you're about to pay. Users who allowed your app in Droplets get their split;
     * everyone else gets it all to the wallet. Gives up after 3 seconds by default: payouts shouldn't wait on Droplets.
     */
    splitAddress: async (address: string, luna: bigint, payoutId?: string, timeoutMs = 3_000): Promise<SaveSplit> =>
      toSplit(await call<SplitReply>(`/v1/save/split?address=${encodeURIComponent(address)}&luna=${luna}${payout(payoutId)}`, undefined, timeoutMs)),
    /** Spend and save: what to charge this address for a price of `luna`. If it throws, charge the price alone. */
    async spend(address: string, luna: bigint, timeoutMs = 3_000): Promise<SpendQuote> {
      const r = await call<{ address: string; spendPercent: number; price: string; save: string; total: string; reason: SaveSplit["reason"] }>(
        `/v1/save/spend?address=${encodeURIComponent(address)}&luna=${luna}`, undefined, timeoutMs,
      );
      return { address: r.address, spendPercent: r.spendPercent, priceLuna: BigInt(r.price), saveLuna: BigInt(r.save), totalLuna: BigInt(r.total), reason: r.reason };
    },
    /**
     * Reports the transactions sent for a payout, by the code you paid or the address. `source: "spend"` marks the
     * part saved when the user paid you. "pending" means not in a block yet: report again shortly.
     */
    receipt: (r: ({ code: string } | { address: string }) & { source?: "payout" | "spend"; payoutId: string; walletTx?: string; growTx?: string }) =>
      call<{ walletTx?: ReceiptStatus; growTx?: ReceiptStatus }>("/v1/save/receipts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(r),
      }),
  };
}

export type SaveApi = ReturnType<typeof createSaveApi>;
