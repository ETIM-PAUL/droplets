import { BREAK_FEE_ADDRESS, toScaled, WalletError, type Step, type WalletExecutor } from "@railkit/core";

/** The slice of the Nimiq Mini App provider (`await init()` from @nimiq/mini-app-sdk) that we use. */
export interface NimiqProviderLike {
  payLightningInvoice(req: { invoice: string }): Promise<{ hash: string; swapId: string }>;
  sendBasicTransaction(tx: { recipient: string; value: number }): Promise<string>;
  /** Present on current Nimiq Pay; when it says false, payments fail after a long timeout. */
  isConsensusEstablished?(): Promise<boolean>;
}

export interface NimiqExecutorOptions {
  /** How long to wait for Nimiq Pay to connect before giving up. */
  consensusWaitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const NOT_CONNECTED = "Nimiq Pay isn't connected to the Nimiq network yet, so nothing was sent. Wait a minute, check your connection, and try again.";

/** Waits until Nimiq Pay reports consensus. A false answer means no payment was attempted. */
async function waitForNetwork(provider: Pick<NimiqProviderLike, "isConsensusEstablished">, o: NimiqExecutorOptions): Promise<void> {
  if (!provider.isConsensusEstablished) return;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tries = Math.max(1, Math.ceil((o.consensusWaitMs ?? 20_000) / (o.pollMs ?? 1_000)));
  for (let i = 0; i < tries; i++) {
    if (await provider.isConsensusEstablished().catch(() => false)) return;
    if (i < tries - 1) await sleep(o.pollMs ?? 1_000);
  }
  throw new WalletError("failed", NOT_CONNECTED);
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
  const code = typeof e === "object" && e && "code" in e ? (e as { code: unknown }).code : undefined;
  const raw = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
  // Keep Nimiq Pay's own type and code in the message, so device reports show exactly what it said.
  const message = `${raw} [${type || "no type"}${code === undefined ? "" : ` ${String(code)}`}]`;

  if (REJECTED.has(type)) return new WalletError("rejected", message);
  // Seen on a real device (2026-10-30): Nimiq Pay's Lightning step "timed out after 30000 milliseconds".
  // A timeout can come after funds left the wallet, so it is never "nothing was sent", whatever the type says.
  if (/timed? ?out/i.test(raw)) return new WalletError("unknown", message);
  if (NOT_SENT.has(type)) return new WalletError("failed", message);
  if (type === "DUPLICATE_PAYMENT") {
    return new WalletError("unknown", "This invoice was already paid or is being paid. Check your wallet history before trying again.");
  }
  return new WalletError("unknown", `${type || "ERROR"}: ${message}`);
}

/** The staking and signing slice of the provider. Each call opens Nimiq Pay's own approval dialog. */
export interface NimiqSaverProvider extends Pick<NimiqProviderLike, "isConsensusEstablished"> {
  sign(message: string): Promise<{ publicKey: string; signature: string }>;
  sendNewStakerTransaction(tx: { delegation: string; value: number }): Promise<string>;
  sendStakeTransaction(tx: { value: number }): Promise<string>;
  sendSetActiveStakeTransaction(tx: { newActiveBalance: number }): Promise<string>;
  sendRetireStakeTransaction(tx: { retireStake: number }): Promise<string>;
  sendRemoveStakeTransaction(tx: { value: number }): Promise<string>;
  sendBasicTransaction(tx: { recipient: string; value: number }): Promise<string>;
}

function toLuna(amount: bigint, allowZero = false): number {
  if (amount < 0n || (!allowZero && amount === 0n) || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new WalletError("failed", "That NIM amount is out of range.");
  return Number(amount);
}

/**
 * Droplets's actions in Nimiq Pay, all on the user's own stake (Grow). Amounts are luna.
 * Nimiq Pay shows its approval dialog for each; nothing here can move money without it.
 */
export function createNimiqSaver(provider: NimiqSaverProvider, options: NimiqExecutorOptions = {}) {
  const run = async <T>(f: () => Promise<T>, needsNetwork = true): Promise<T> => {
    if (needsNetwork) await waitForNetwork(provider, options);
    try {
      return await f();
    } catch (e) {
      throw classifyNimiqError(e);
    }
  };
  return {
    /** Signs a Droplets request: setting or revoking the save rule, or joining or leaving the weekly draw. Returns the key Nimiq Pay signed with, so the server can check it's this address. */
    signRule: (message: string) => run(() => provider.sign(message), false),
    /** Opens Grow: stakes at least 100 NIM with the chosen validator. */
    openGrow: (validator: string, luna: bigint) => run(() => provider.sendNewStakerTransaction({ delegation: validator, value: toLuna(luna) })),
    addToGrow: (luna: bigint) => run(() => provider.sendStakeTransaction({ value: toLuna(luna) })),
    /** Step 1 of withdrawing: the rest of the stake becomes inactive and its lock-up starts at the next election block. */
    startWithdrawal: (newActiveLuna: bigint) => run(() => provider.sendSetActiveStakeTransaction({ newActiveBalance: toLuna(newActiveLuna, true) })),
    /** Step 2, once released: inactive stake becomes retired. */
    retire: (luna: bigint) => run(() => provider.sendRetireStakeTransaction({ retireStake: toLuna(luna) })),
    /** Step 3: the retired stake goes back to the wallet. Must be the whole retired amount. */
    remove: (luna: bigint) => run(() => provider.sendRemoveStakeTransaction({ value: toLuna(luna) })),
    /** Pays the fee to break a locked goal early, from the wallet: staked NIM can only ever pay back its own owner, never a third party. */
    payBreakFee: (luna: bigint) => run(() => provider.sendBasicTransaction({ recipient: BREAK_FEE_ADDRESS, value: toLuna(luna) })),
  };
}

export type NimiqSaver = ReturnType<typeof createNimiqSaver>;

/** Runs pay-lightning-invoice and send-nim steps in Nimiq Pay; the host shows its native approval dialog. */
export function createNimiqExecutor(provider: NimiqProviderLike, options: NimiqExecutorOptions = {}): WalletExecutor {
  return {
    async execute(step: Step) {
      await waitForNetwork(provider, options);
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
