// Server-side payouts with save codes. Signs with the paying app's own payout key, never a user's.
// The signing guard only allows that here, and keeps this file out of the Mini App and the API.
import { parseNimiqAddress, parseSaveCode, type NimiqRpc } from "@railkit/core";
import { SaveApiError, type SaveApi } from "./index";

/** The slice of @nimiq/core used here. Pass the real module: `await import("@nimiq/core")`. */
export interface NimiqCoreLike {
  Address: { fromString(address: string): unknown };
  TransactionBuilder: {
    newBasic(sender: unknown, recipient: unknown, value: bigint, fee: bigint | null | undefined, validityStartHeight: number, networkId: number): NimiqTx;
    newBasicWithData(sender: unknown, recipient: unknown, data: Uint8Array, value: bigint, fee: bigint | null | undefined, validityStartHeight: number, networkId: number): NimiqTx;
    newAddStake(sender: unknown, stakerAddress: unknown, value: bigint, fee: bigint | null | undefined, validityStartHeight: number, networkId: number): NimiqTx;
  };
}
export interface NimiqTx {
  sign(keyPair: unknown, innerKeyPair: undefined): void;
  toHex(): string;
  hash(): string;
}
/** The app's payout key pair (@nimiq/core KeyPair). */
export interface PayoutKeyPair {
  toAddress(): unknown;
}

export interface SentTx {
  kind: "wallet" | "grow";
  luna: bigint;
  hash: string;
  hex: string;
}

export interface PayoutRecord {
  payoutId: string;
  /** null for a plain payment to an address. */
  code: string | null;
  address: string;
  validityStartHeight: number;
  txs: SentTx[];
}

/** Remembers what was signed for each payout, so a retry resends the same transactions and never pays twice. */
export interface PayoutLog {
  get(payoutId: string): Promise<PayoutRecord | undefined>;
  put(record: PayoutRecord): Promise<void>;
}

/** In memory: fine for tests and one process. Use a database-backed log in production. */
export function memoryPayoutLog(): PayoutLog {
  const m = new Map<string, PayoutRecord>();
  return { get: async (id) => m.get(id), put: async (r) => void m.set(r.payoutId, r) };
}

export interface SavePayerOptions {
  /** From createSaveApi. Not needed if you only ever pay plain addresses. */
  api?: SaveApi;
  rpc: Pick<NimiqRpc, "blockNumber" | "sendRawTransaction" | "transaction" | "network">;
  nimiq: NimiqCoreLike;
  keyPair: PayoutKeyPair;
  network: "main" | "test";
  log?: PayoutLog;
  /** Luna per transaction; Nimiq currently accepts 0. */
  fee?: bigint;
  receiptTries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PayResult {
  payoutId: string;
  address: string;
  walletTx: string | null;
  growTx: string | null;
  walletLuna: bigint;
  growLuna: bigint;
  /** Why nothing went to Grow when the user's rule asked for some; null otherwise. */
  reason: string | null;
  /** True when this payout was already sent and this call only made sure it went out. */
  repeated: boolean;
}

const NETWORK_ID = { main: 24, test: 5 } as const;
const NETWORK_NAME = { main: "MainAlbatross", test: "TestAlbatross" } as const;
/** A transaction is only valid for this many blocks after its validity start height. */
const VALIDITY_WINDOW = 7_200;
const PAYOUT_ID = /^[\w:.-]{1,100}$/;

export function createSavePayer(o: SavePayerOptions) {
  const log = o.log ?? memoryPayoutLog();
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fee = o.fee ?? 0n;

  let networkChecked: Promise<void> | undefined;
  /**
   * Nodes accept a transaction signed for the other network and answer with its hash, but it never lands.
   * So check once which chain the node follows. A failed check is retried; a wrong network stays an error.
   */
  function checkNetwork() {
    networkChecked ??= o.rpc.network().then(
      (n) => {
        if (n !== NETWORK_NAME[o.network]) {
          throw new Error(`The Nimiq node follows ${n}, but this payer signs for ${NETWORK_NAME[o.network]}. Nothing was sent: use a ${o.network === "main" ? "mainnet" : "testnet"} node.`);
        }
      },
      (e) => {
        networkChecked = undefined;
        throw e;
      },
    );
    return networkChecked;
  }

  /** Sends a signed transaction. "Already known" means it's in the mempool or chain: fine. A plain success proves nothing. */
  async function broadcast(tx: SentTx) {
    try {
      await o.rpc.sendRawTransaction(tx.hex);
    } catch (e) {
      if (await o.rpc.transaction(tx.hash).catch(() => null)) return;
      // Whole words only: "Unknown account" is a real error.
      if (/\b(already|known|duplicate)\b/i.test(String((e as { data?: unknown }).data ?? (e as Error).message))) return;
      throw e;
    }
  }

  async function report(record: PayoutRecord) {
    if (!o.api || !record.code) return;
    const body = {
      code: record.code,
      payoutId: record.payoutId,
      ...Object.fromEntries(record.txs.map((t) => [t.kind === "wallet" ? "walletTx" : "growTx", t.hash])),
    };
    for (let i = 0; i < (o.receiptTries ?? 10); i++) {
      const r = await o.api.receipt(body);
      if (!Object.values(r).includes("pending")) return;
      await sleep(2_000);
    }
    // Still pending: the payment is sent; the user's history catches up when you report again.
  }

  return {
    /** Throws unless the node follows the network this payer signs for. pay() checks this too; call it at startup to fail early. */
    checkNetwork,
    /**
     * Pays `luna` to a save code (split by the user's rule) or to a plain Nimiq address. For an address,
     * `into: "grow"` sends it all as an add-stake into that address's own stake instead of to its wallet.
     * Safe to retry with the same payoutId: the same signed transactions are resent, never new ones.
     */
    async pay(p: { to: string; luna: bigint; payoutId: string; memo?: string; into?: "wallet" | "grow" }): Promise<PayResult> {
      if (!PAYOUT_ID.test(p.payoutId)) throw new RangeError("payoutId: 1 to 100 letters, digits or _ : . -");
      if (p.luna <= 0n) throw new RangeError("luna must be above 0.");
      const memo = p.memo === undefined ? undefined : new TextEncoder().encode(p.memo);
      if (memo && memo.length > 64) throw new RangeError("memo: at most 64 bytes.");
      await checkNetwork();

      const done = await log.get(p.payoutId);
      if (done) {
        const height = await o.rpc.blockNumber();
        for (const tx of done.txs) {
          if (await o.rpc.transaction(tx.hash).catch(() => null)) continue;
          if (height >= done.validityStartHeight + VALIDITY_WINDOW) {
            throw new Error(`Payout ${p.payoutId} was signed but never confirmed, and has expired. Check before paying again.`);
          }
          await broadcast(tx);
        }
        await report(done);
        const sum = (k: SentTx["kind"]) => done.txs.filter((t) => t.kind === k).reduce((a, t) => a + t.luna, 0n);
        return {
          payoutId: p.payoutId, address: done.address, walletTx: done.txs.find((t) => t.kind === "wallet")?.hash ?? null,
          growTx: done.txs.find((t) => t.kind === "grow")?.hash ?? null, walletLuna: sum("wallet"), growLuna: sum("grow"), reason: null, repeated: true,
        };
      }

      let code: string | null = null;
      let address: string;
      let walletLuna = p.luna;
      let growLuna = 0n;
      let staker = "";
      let reason: string | null = null;
      const asCode = parseSaveCode(p.to);
      if (asCode.ok) {
        if (!o.api) throw new SaveApiError("Paying a save code needs the Errand API (pass `api`).", 0);
        const split = await o.api.split(asCode.value, p.luna, p.payoutId);
        code = asCode.value;
        address = split.address;
        walletLuna = split.walletLuna;
        growLuna = split.growLuna;
        staker = split.staker;
        reason = split.reason;
      } else {
        const a = parseNimiqAddress(p.to);
        if (!a.ok) throw new RangeError("`to` must be a save code (SAVE-…) or a Nimiq address.");
        address = a.value;
        if (p.into === "grow") {
          // An add-stake carries no memo, and fails on-chain unless the address already has a stake: callers check that.
          if (memo) throw new RangeError("A payment into Grow can't carry a memo.");
          [walletLuna, growLuna, staker] = [0n, p.luna, address];
        }
      }

      const height = await o.rpc.blockNumber();
      const network = NETWORK_ID[o.network];
      const sender = o.keyPair.toAddress();
      const txs: SentTx[] = [];
      const signed = (tx: NimiqTx, kind: SentTx["kind"], luna: bigint) => {
        tx.sign(o.keyPair, undefined);
        txs.push({ kind, luna, hash: tx.hash(), hex: tx.toHex() });
      };
      if (walletLuna > 0n) {
        const to = o.nimiq.Address.fromString(address);
        signed(memo ? o.nimiq.TransactionBuilder.newBasicWithData(sender, to, memo, walletLuna, fee, height, network) : o.nimiq.TransactionBuilder.newBasic(sender, to, walletLuna, fee, height, network), "wallet", walletLuna);
      }
      if (growLuna > 0n) {
        signed(o.nimiq.TransactionBuilder.newAddStake(sender, o.nimiq.Address.fromString(staker), growLuna, fee, height, network), "grow", growLuna);
      }
      const record: PayoutRecord = { payoutId: p.payoutId, code, address, validityStartHeight: height, txs };
      // Written before sending: if the process dies mid-way, the retry resends these exact transactions.
      await log.put(record);
      for (const tx of txs) await broadcast(tx);
      await report(record);
      return {
        payoutId: p.payoutId, address, walletTx: txs.find((t) => t.kind === "wallet")?.hash ?? null, growTx: txs.find((t) => t.kind === "grow")?.hash ?? null,
        walletLuna, growLuna, reason, repeated: false,
      };
    },
  };
}
