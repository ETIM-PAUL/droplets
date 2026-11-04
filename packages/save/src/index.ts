// @railkit/save: pay rewards into a user's savings with their save code. Server-side: the app key is a secret.
// Building and sending payments is in "@railkit/save/payer"; this entry only talks to the RailKit API.
export { formatSaveCode, parseSaveCode } from "@railkit/core";

export class SaveApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface SaveSplit {
  code: string;
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

export type ReceiptStatus = "recorded" | "pending";

export interface SaveApiOptions {
  /** e.g. https://api.errand.example */
  apiUrl: string;
  /** rk_save_…, issued by Errand. Keep it on your server. */
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createSaveApi(o: SaveApiOptions) {
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = o.apiUrl.replace(/\/$/, "");

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(base + path, {
        ...init,
        headers: { ...(init?.headers as Record<string, string> | undefined), Authorization: `Bearer ${o.apiKey}` },
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      });
    } catch {
      throw new SaveApiError("Couldn't reach the Errand API.", 0);
    }
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!res.ok) throw new SaveApiError(body?.error?.message ?? `Errand API answered ${res.status}`, res.status);
    return body as T;
  }

  return {
    /** How to split `luna` for this code. Throws SaveApiError 404 when the code isn't active. */
    async split(code: string, luna: bigint): Promise<SaveSplit> {
      const r = await call<{ code: string; address: string; savePercent: number; wallet: { luna: string }; grow: { luna: string; staker: string } | null; reason: SaveSplit["reason"] }>(
        `/v1/save/split?code=${encodeURIComponent(code)}&luna=${luna}`,
      );
      return {
        code: r.code, address: r.address, savePercent: r.savePercent, walletLuna: BigInt(r.wallet.luna),
        growLuna: r.grow ? BigInt(r.grow.luna) : 0n, staker: r.grow?.staker ?? r.address, reason: r.reason,
      };
    },
    /** Reports the transactions sent for a payout. "pending" means not in a block yet: report again shortly. */
    receipt: (r: { code: string; payoutId: string; walletTx?: string; growTx?: string }) =>
      call<{ walletTx?: ReceiptStatus; growTx?: ReceiptStatus }>("/v1/save/receipts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(r),
      }),
  };
}

export type SaveApi = ReturnType<typeof createSaveApi>;
