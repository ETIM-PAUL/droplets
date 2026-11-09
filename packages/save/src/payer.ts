// Server-side payouts with save codes or to savers' addresses, and spend and save. Signs with the paying app's own
// payout key, never a user's. The signing guard only allows that here, and keeps this file out of the Mini App and the API.
import { parseNimiqAddress, parseSaveCode, splitPayout, type GrowState, type NimiqRpc } from "@railkit/core";
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
  /** The save code paid; null for an address. */
  code: string | null;
  address: string;
  /** True when Droplets recognised the address as a saver who allowed this app: receipts go back by address. */
  byAddress?: boolean;
  /** "spend": the part saved on top when the user paid the app. Absent means a payout. */
  source?: "payout" | "spend";
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
  /** From createSaveApi. Without it, addresses are paid plainly and codes can't be paid. */
  api?: SaveApi;
  /** staker and validator are needed for saveFromSpend, to check the user's stake can still take the saved part. */
  rpc: Pick<NimiqRpc, "blockNumber" | "sendRawTransaction" | "transaction" | "network"> & Partial<Pick<NimiqRpc, "staker" | "validator">>;
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
    if (!o.api || (!record.code && !record.byAddress)) return;
    const body = {
      ...(record.code ? { code: record.code } : { address: record.address }),
      ...(record.source === "spend" ? { source: "spend" as const } : {}),
      payoutId: record.payoutId,
      ...Object.fromEntries(record.txs.map((t) => [t.kind === "wallet" ? "walletTx" : "growTx", t.hash])),
    };
    for (let i = 0; i < (o.receiptTries ?? 10); i++) {
      const r = await o.api.receipt(body).catch((e: unknown) => {
        // The user stopped allowing this app after the payment went out: it's sent, there's just nothing to record.
        if (record.byAddress && e instanceof SaveApiError && e.status === 404) return null;
        throw e;
      });
      if (!r || !Object.values(r).includes("pending")) return;
      await sleep(2_000);
    }
    // Still pending: the payment is sent; the user's history catches up when you report again.
  }

  /** Before anything is signed: the inputs, the network, and whether this payoutId was already sent. */
  async function begin(p: { luna: bigint; payoutId: string }) {
    if (!PAYOUT_ID.test(p.payoutId)) throw new RangeError("payoutId: 1 to 100 letters, digits or _ : . -");
    if (p.luna <= 0n) throw new RangeError("luna must be above 0.");
    await checkNetwork();
    return log.get(p.payoutId);
  }

  /** A payout that was already signed: resend whatever isn't on-chain yet, and report it again. */
  async function resend(done: PayoutRecord): Promise<PayResult> {
    const height = await o.rpc.blockNumber();
    for (const tx of done.txs) {
      if (await o.rpc.transaction(tx.hash).catch(() => null)) continue;
      if (height >= done.validityStartHeight + VALIDITY_WINDOW) {
        throw new Error(`Payout ${done.payoutId} was signed but never confirmed, and has expired. Check before paying again.`);
      }
      await broadcast(tx);
    }
    await report(done);
    const sum = (k: SentTx["kind"]) => done.txs.filter((t) => t.kind === k).reduce((a, t) => a + t.luna, 0n);
    return {
      payoutId: done.payoutId, address: done.address, walletTx: done.txs.find((t) => t.kind === "wallet")?.hash ?? null,
      growTx: done.txs.find((t) => t.kind === "grow")?.hash ?? null, walletLuna: sum("wallet"), growLuna: sum("grow"), reason: null, repeated: true,
    };
  }

  /** Signs the plan, records it, then sends it: if the process dies mid-way, the retry resends these exact transactions. */
  async function send(plan: Omit<PayoutRecord, "validityStartHeight" | "txs"> & { walletLuna: bigint; growLuna: bigint; memo?: Uint8Array; reason: string | null }): Promise<PayResult> {
    const { walletLuna, growLuna, memo, reason, ...rest } = plan;
    const height = await o.rpc.blockNumber();
    const network = NETWORK_ID[o.network];
    const sender = o.keyPair.toAddress();
    const txs: SentTx[] = [];
    const signed = (tx: NimiqTx, kind: SentTx["kind"], luna: bigint) => {
      tx.sign(o.keyPair, undefined);
      txs.push({ kind, luna, hash: tx.hash(), hex: tx.toHex() });
    };
    if (walletLuna > 0n) {
      const to = o.nimiq.Address.fromString(plan.address);
      signed(memo ? o.nimiq.TransactionBuilder.newBasicWithData(sender, to, memo, walletLuna, fee, height, network) : o.nimiq.TransactionBuilder.newBasic(sender, to, walletLuna, fee, height, network), "wallet", walletLuna);
    }
    if (growLuna > 0n) {
      // The user's own stake: the staker is the address being paid.
      signed(o.nimiq.TransactionBuilder.newAddStake(sender, o.nimiq.Address.fromString(plan.address), growLuna, fee, height, network), "grow", growLuna);
    }
    const record: PayoutRecord = { ...rest, validityStartHeight: height, txs };
    await log.put(record);
    for (const tx of txs) await broadcast(tx);
    await report(record);
    return {
      payoutId: plan.payoutId, address: plan.address, walletTx: txs.find((t) => t.kind === "wallet")?.hash ?? null, growTx: txs.find((t) => t.kind === "grow")?.hash ?? null,
      walletLuna, growLuna, reason, repeated: false,
    };
  }

  return {
    /** Throws unless the node follows the network this payer signs for. pay() checks this too; call it at startup to fail early. */
    checkNetwork,
    /**
     * Pays `luna` to a save code, or to the Nimiq address you'd pay anyway. Both are split by the user's rule:
     * an address only if its owner allowed your app in Droplets, otherwise it's one normal payment. If Droplets
     * doesn't answer within 3 seconds, the address gets one normal payment too. `into: "wallet"` never asks
     * Droplets (use it for refunds); `into: "grow"` sends it all as an add-stake into that address's own stake.
     * Safe to retry with the same payoutId: the same signed transactions are resent, never new ones.
     */
    async pay(p: { to: string; luna: bigint; payoutId: string; memo?: string; into?: "wallet" | "grow" }): Promise<PayResult> {
      const memo = p.memo === undefined ? undefined : new TextEncoder().encode(p.memo);
      if (memo && memo.length > 64) throw new RangeError("memo: at most 64 bytes.");
      const asCode = parseSaveCode(p.to);
      const asAddress = asCode.ok ? null : parseNimiqAddress(p.to);
      if (asAddress && !asAddress.ok) throw new RangeError("`to` must be a save code (SAVE-…) or a Nimiq address.");
      // An add-stake carries no memo, and fails on-chain unless the address already has a stake: callers check that.
      if (p.into === "grow" && memo) throw new RangeError("A payment into Grow can't carry a memo.");
      const done = await begin(p);
      if (done) return resend(done);

      if (asCode.ok) {
        if (!o.api) throw new SaveApiError("Paying a save code needs the Droplets API (pass `api`).", 0);
        const split = await o.api.split(asCode.value, p.luna, p.payoutId);
        return send({ payoutId: p.payoutId, code: asCode.value, address: split.address, walletLuna: split.walletLuna, growLuna: split.growLuna, memo, reason: split.reason });
      }
      const address = asAddress!.ok ? asAddress!.value : "";
      if (p.into === "grow") return send({ payoutId: p.payoutId, code: null, address, walletLuna: 0n, growLuna: p.luna, reason: null });
      if (p.into === undefined && o.api) {
        const split = await o.api.splitAddress(address, p.luna, p.payoutId).catch(() => null);
        // A saver who allowed this app: savings went in, or the reason they couldn't is worth recording.
        if (split && (split.growLuna > 0n || split.reason !== null)) {
          return send({ payoutId: p.payoutId, code: null, byAddress: true, address, walletLuna: split.walletLuna, growLuna: split.growLuna, memo, reason: split.reason });
        }
      }
      return send({ payoutId: p.payoutId, code: null, address, walletLuna: p.luna, growLuna: 0n, memo, reason: null });
    },

    /**
     * Spend and save: once a user has paid you a quote's totalLuna, puts its saveLuna into their own stake. If their
     * stake can't take it any more (it closed, or its validator left), it goes back to their wallet instead, so the
     * saved part is never kept. Retry-safe like pay(). Needs `rpc.staker` and `rpc.validator`.
     */
    async saveFromSpend(p: { to: string; luna: bigint; payoutId: string }): Promise<PayResult> {
      const a = parseNimiqAddress(p.to);
      if (!a.ok) throw new RangeError("`to` must be the Nimiq address that paid you.");
      if (!o.rpc.staker || !o.rpc.validator) throw new Error("saveFromSpend needs rpc.staker and rpc.validator (createNimiqRpc has both).");
      const done = await begin(p);
      if (done) return resend(done);
      const staker = await o.rpc.staker(a.value);
      const grow: GrowState = !staker ? { open: false, reason: "no-stake" } : (await o.rpc.validator(staker.delegation)) ? { open: true, staker } : { open: false, reason: "validator-gone" };
      const split = splitPayout(p.luna, 100, grow);
      return send({ payoutId: p.payoutId, code: null, byAddress: true, source: "spend", address: a.value, walletLuna: split.wallet, growLuna: split.grow, reason: split.reason });
    },
  };
}
