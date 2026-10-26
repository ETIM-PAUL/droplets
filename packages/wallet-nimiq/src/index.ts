import { toScaled, WalletError, type Step, type WalletExecutor } from "@railkit/core";

/** The slice of the Nimiq Mini App provider (`await init()` from @nimiq/mini-app-sdk) that we use. */
export interface NimiqProviderLike {
  payLightningInvoice(req: { invoice: string }): Promise<{ hash: string; swapId: string }>;
  sendBasicTransaction(tx: { recipient: string; value: number }): Promise<string>;
}

const LUNA_PER_NIM = 100_000n;
const SCALE = 10n ** 18n;

/** NIM decimal string to whole luna. Throws if there are more than 5 decimals or it is too large. */
export function nimToLuna(amount: string): number {
  const scaled = toScaled(amount) * LUNA_PER_NIM;
  if (scaled % SCALE !== 0n) throw new WalletError("failed", "NIM amounts can have at most 5 decimal places.");
  const luna = scaled / SCALE;
  if (luna <= 0n || luna > BigInt(Number.MAX_SAFE_INTEGER)) throw new WalletError("failed", "That NIM amount is out of range.");
  return Number(luna);
}

// Error types we know from the SDK (4001 and -32602 mapping, readme for the other two).
// Only types that prove nothing was submitted are "failed" or "rejected".
// Everything else could have happened after submission, so it is "unknown" and must never be retried blindly.
const REJECTED = new Set(["PERMISSION_DENIED"]);
const NOT_SENT = new Set(["INVALID_TRANSACTION", "UNKNOWN_REQUEST"]);

export function classifyNimiqError(e: unknown): WalletError {
  if (e instanceof WalletError) return e;
  const type = typeof e === "object" && e && "type" in e ? String((e as { type: unknown }).type) : "";
  const message = e instanceof Error ? e.message : String(e);

  if (REJECTED.has(type)) return new WalletError("rejected", message);
  if (NOT_SENT.has(type)) return new WalletError("failed", message);
  if (type === "DUPLICATE_PAYMENT") {
    return new WalletError("unknown", "This invoice was already paid or is being paid. Check your wallet history before trying again.");
  }
  return new WalletError("unknown", `${type || "ERROR"}: ${message}`);
}

/** Runs pay-lightning-invoice and send-nim steps in Nimiq Pay; the host shows its native approval dialog. */
export function createNimiqExecutor(provider: NimiqProviderLike): WalletExecutor {
  return {
    async execute(step: Step) {
      try {
        switch (step.kind) {
          case "pay-lightning-invoice": {
            const { hash, swapId } = await provider.payLightningInvoice({ invoice: step.invoice });
            // Success means the payment transaction was submitted, not that Lightning has settled.
            return { ref: `${hash}:${swapId}` };
          }
          case "send-nim": {
            if (step.amount.currency !== "NIM") throw new WalletError("failed", "send-nim needs an amount in NIM.");
            const tx = await provider.sendBasicTransaction({ recipient: step.to, value: nimToLuna(step.amount.amount) });
            return { ref: tx };
          }
          default:
            throw new WalletError("failed", `Nimiq Pay can't run a "${step.kind}" step.`);
        }
      } catch (e) {
        throw classifyNimiqError(e);
      }
    },
  };
}
