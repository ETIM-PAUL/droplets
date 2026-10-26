import { toScaled, WalletError, type Step, type WalletExecutor } from "@railkit/core";

/** EIP-1193 provider, as injected at `window.ethereum`. */
export interface Eip1193Like {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface TokenConfig {
  /** Chain name used by steps, e.g. "polygon". */
  chain: string;
  chainId: number;
  /** Currency code on the step's amount, e.g. "USDT". */
  symbol: string;
  /** Token contract address. Must be checked against the issuer's official list before use; we ship none. */
  address: string;
  decimals: number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Amount decimal string to the token's smallest unit. Throws if it has more decimals than the token. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const scaled = toScaled(amount);
  const factor = 10n ** BigInt(18 - decimals);
  if (scaled % factor !== 0n) throw new WalletError("failed", `This token supports at most ${decimals} decimal places.`);
  return scaled / factor;
}

/** ERC-20 transfer(address,uint256) calldata. */
export function encodeTransfer(to: string, units: bigint): string {
  if (!ADDRESS.test(to)) throw new WalletError("failed", "The recipient address is not a valid EVM address.");
  return "0xa9059cbb" + to.slice(2).toLowerCase().padStart(64, "0") + units.toString(16).padStart(64, "0");
}

const REJECTED_CODE = 4001;
const NOT_SENT_CODES = new Set([-32602, 4100, 4200, 4900, 4901]);

export function classifyEvmError(e: unknown): WalletError {
  if (e instanceof WalletError) return e;
  const code = typeof e === "object" && e && "code" in e ? Number((e as { code: unknown }).code) : NaN;
  const message = e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e);
  if (code === REJECTED_CODE) return new WalletError("rejected", message);
  if (NOT_SENT_CODES.has(code)) return new WalletError("failed", message);
  return new WalletError("unknown", message);
}

/** Runs evm-transfer steps as ERC-20 transfers through the wallet's EIP-1193 provider. */
export function createEvmExecutor(provider: Eip1193Like, tokens: TokenConfig[]): WalletExecutor {
  return {
    async execute(step: Step) {
      try {
        if (step.kind !== "evm-transfer") throw new WalletError("failed", `This wallet can't run a "${step.kind}" step.`);
        const token = tokens.find((t) => t.chain === step.chain && t.symbol === step.amount.currency);
        if (!token) throw new WalletError("failed", `${step.amount.currency} on ${step.chain} isn't supported yet.`);

        // Nothing is sent before every check below passes.
        const chainId = Number(await provider.request({ method: "eth_chainId" }));
        if (chainId !== token.chainId) throw new WalletError("failed", `Your wallet is on a different network. Switch to ${step.chain} and try again.`);
        const [from] = (await provider.request({ method: "eth_requestAccounts" })) as string[];
        if (!from) throw new WalletError("failed", "No account is available in your wallet.");

        const data = encodeTransfer(step.to, toBaseUnits(step.amount.amount, token.decimals));
        const hash = await provider.request({ method: "eth_sendTransaction", params: [{ from, to: token.address, data }] });
        if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
          throw new WalletError("unknown", "The wallet didn't return a transaction hash. Check your wallet history before retrying.");
        }
        return { ref: hash };
      } catch (e) {
        throw classifyEvmError(e);
      }
    },
  };
}
