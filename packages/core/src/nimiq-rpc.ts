import type { StakerState } from "./save";

/** A JSON-RPC error from the Nimiq node. `data` carries the node's own words, e.g. "No staker with address: …". */
export class NimiqRpcError extends Error {
  constructor(message: string, readonly code: number | null, readonly data: string | null) {
    super(message);
  }
}

export interface NimiqRpcOptions {
  /** e.g. https://rpc.nimiqwatch.com (mainnet) or https://rpc.testnet.nimiqwatch.com. */
  url: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface NimiqValidator {
  address: string;
  /** Luna staked with it, its own deposit included. */
  balance: bigint;
  numStakers: number;
  jailedFrom: number | null;
  retired: boolean;
}

export interface NimiqTransaction {
  hash: string;
  blockNumber: number;
  from: string;
  to: string;
  value: bigint;
  /** Hex. An add-stake starts with 06 followed by the staker's 20 address bytes. */
  recipientData: string;
  /** Hex. A stake leaving the staking contract (remove-stake) starts with 01. */
  senderData: string;
  executionResult: boolean;
  confirmations: number;
  /** Block time, ms since 1970. */
  timestamp: number;
  /** The recipient's account type: 0 basic, 1 vesting, 2 HTLC, 3 staking. Absent when unknown. */
  toType?: number;
  /** 1 when this transaction creates the recipient contract, such as a new HTLC; 2 for a staking signal. */
  flags?: number;
}

/** A block's place, fingerprint and time. */
export interface NimiqBlock {
  number: number;
  hash: string;
  /** Ms since 1970. Blocks come about one a second. */
  timestamp: number;
}

interface RawStaker { balance: number; inactiveBalance: number; inactiveFrom: number | null; retiredBalance: number; delegation: string }
interface RawValidator { address: string; balance: number; numStakers: number; jailedFrom: number | null; retired: boolean }
interface RawBlock { number: number; hash: string; timestamp: number }
interface RawTx { hash: string; blockNumber: number; from: string; to: string; toType?: number; flags?: number; value: number; recipientData: string | null; senderData: string | null; executionResult: boolean; confirmations: number; timestamp: number }

const toBig = (n: number | string) => BigInt(n);
const toBlock = (b: RawBlock): NimiqBlock => ({ number: b.number, hash: b.hash, timestamp: b.timestamp });
const toTx = (t: RawTx): NimiqTransaction => ({
  hash: t.hash, blockNumber: t.blockNumber, from: t.from, to: t.to, value: toBig(t.value), recipientData: t.recipientData ?? "",
  senderData: t.senderData ?? "", executionResult: t.executionResult, confirmations: t.confirmations, timestamp: t.timestamp ?? 0,
  ...(t.toType === undefined ? {} : { toType: t.toType }), ...(t.flags === undefined ? {} : { flags: t.flags }),
});

/** The few calls Droplets needs from a Nimiq PoS node. Read-only, plus sending transactions that are already signed. */
export function createNimiqRpc(o: NimiqRpcOptions) {
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  let id = 0;

  async function call<T>(method: string, params: unknown[]): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(o.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      });
    } catch {
      throw new NimiqRpcError("Couldn't reach the Nimiq network. Try again in a minute.", null, null);
    }
    const j = (await res.json().catch(() => null)) as { result?: { data: T }; error?: { code?: number; message?: string; data?: string } } | null;
    if (j?.error) throw new NimiqRpcError(j.error.message ?? "Nimiq node error", j.error.code ?? null, typeof j.error.data === "string" ? j.error.data : null);
    if (!res.ok || !j?.result) throw new NimiqRpcError(`Nimiq node answered ${res.status}`, null, null);
    return j.result.data;
  }

  /** null when the node says the thing doesn't exist; other errors are thrown. */
  const orNull = async <T>(p: Promise<T>, notFound: RegExp): Promise<T | null> => {
    try {
      return await p;
    } catch (e) {
      if (e instanceof NimiqRpcError && notFound.test(e.data ?? "")) return null;
      throw e;
    }
  };

  return {
    blockNumber: () => call<number>("getBlockNumber", []),

    latestBlock: async (): Promise<NimiqBlock> => toBlock(await call<RawBlock>("getLatestBlock", [false])),
    block: async (number: number): Promise<NimiqBlock> => toBlock(await call<RawBlock>("getBlockByNumber", [number, false])),

    async staker(address: string): Promise<StakerState | null> {
      const s = await orNull(call<RawStaker>("getStakerByAddress", [address]), /^No staker/i);
      return s && { active: toBig(s.balance), inactive: toBig(s.inactiveBalance), inactiveFrom: s.inactiveFrom, retired: toBig(s.retiredBalance), delegation: s.delegation };
    },

    async validator(address: string): Promise<NimiqValidator | null> {
      const v = await orNull(call<RawValidator>("getValidatorByAddress", [address]), /^No validator/i);
      return v && { address: v.address, balance: toBig(v.balance), numStakers: v.numStakers, jailedFrom: v.jailedFrom, retired: v.retired };
    },

    async activeValidators(): Promise<NimiqValidator[]> {
      const list = await call<RawValidator[]>("getActiveValidators", []);
      return list.map((v) => ({ address: v.address, balance: toBig(v.balance), numStakers: v.numStakers, jailedFrom: v.jailedFrom, retired: v.retired }));
    },

    async transaction(hash: string): Promise<NimiqTransaction | null> {
      const t = await orNull(call<RawTx>("getTransactionByHash", [hash]), /^Transaction not found/i);
      return t && toTx(t);
    },

    /** The latest transactions to or from an address, newest first. */
    async transactionsByAddress(address: string, max = 100): Promise<NimiqTransaction[]> {
      const list = await call<RawTx[]>("getTransactionsByAddress", [address, max, null]);
      return list.map(toTx);
    },

    /** Luna held by a basic account; 0 for an address that has never received anything. */
    async balance(address: string): Promise<bigint> {
      const a = await call<{ balance: number }>("getAccountByAddress", [address]);
      return toBig(a.balance);
    },

    /** Which chain the node follows, from its latest block: "MainAlbatross" or "TestAlbatross". */
    network: async () => (await call<{ network: string }>("getLatestBlock", [false])).network,

    /**
     * Sends a signed transaction (hex). Returns its hash. Public nodes answer with the hash even for a
     * transaction that can never land (unfunded, expired, or for the other network), so only `transaction(hash)` proves it went through.
     */
    sendRawTransaction: (hex: string) => call<string>("sendRawTransaction", [hex]),
  };
}

export type NimiqRpc = ReturnType<typeof createNimiqRpc>;
