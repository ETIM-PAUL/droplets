import { describe, expect, it } from "vitest";
import { createSaveApi, SaveApiError } from "./index";
import { createSavePayer, memoryPayoutLog, type NimiqCoreLike, type NimiqTx } from "./payer";

const USER = "NQ23 4CTV GPEU C004 7USS EPFM RQ5C METQ EMDP";
const PAYOUT = "NQ49 N8MB XYCR XBUP 404C KXKK L49M A7BT F082";
const NIM = (n: number) => BigInt(n) * 100_000n;

/** Records what would be built and signed; hashes are made up but stable. */
function fakeNimiq() {
  const built: unknown[][] = [];
  let n = 0;
  const tx = (kind: string, args: unknown[]): NimiqTx => {
    built.push([kind, ...args]);
    const id = (++n).toString(16).padStart(64, "0");
    let signedWith: unknown;
    return {
      sign: (k) => void (signedWith = k),
      toHex: () => (signedWith ? `hex-${id}` : "unsigned"),
      hash: () => id,
    };
  };
  const nimiq: NimiqCoreLike = {
    Address: { fromString: (a) => `addr(${a})` },
    TransactionBuilder: {
      newBasic: (...a) => tx("basic", a),
      newBasicWithData: (s, r, d, ...rest) => tx("basicWithData", [s, r, new TextDecoder().decode(d), ...rest]),
      newAddStake: (...a) => tx("addStake", a),
    },
  };
  return { nimiq, built };
}

function fakeRpc() {
  const sent: string[] = [];
  const onChain = new Set<string>();
  return {
    sent,
    onChain,
    rpc: {
      blockNumber: async () => 1_000,
      sendRawTransaction: async (hex: string) => (sent.push(hex), hex.slice(4)),
      transaction: async (hash: string) => (onChain.has(hash) ? ({ hash } as never) : null),
    },
  };
}

function fakeApi(split: { walletLuna: bigint; growLuna: bigint; reason?: string | null }, receiptAnswers: Record<string, string>[] = [{}]) {
  const receipts: unknown[] = [];
  return {
    receipts,
    api: {
      split: async (code: string) => ({ code: `SAVE-${code}`, address: USER, savePercent: 30, staker: USER, reason: null, ...split }) as never,
      receipt: async (r: unknown) => (receipts.push(r), (receiptAnswers.shift() ?? { growTx: "recorded" }) as never),
    },
  };
}

const KEYPAIR = { toAddress: () => `addr(${PAYOUT})` };

/** A real, valid code (the check character is computed) so parseSaveCode accepts it. */
async function realCode() {
  const { newSaveCode } = await import("@railkit/core");
  return newSaveCode(() => new Uint8Array([1, 2, 3, 4, 5, 6]));
}

describe("createSavePayer", () => {
  it("pays a save code in two parts: a normal payment and an add-stake into the user's Grow", async () => {
    const { nimiq, built } = fakeNimiq();
    const { rpc, sent } = fakeRpc();
    const { api, receipts } = fakeApi({ walletLuna: NIM(1400), growLuna: NIM(600) });
    const code = await realCode();
    const r = await createSavePayer({ api, rpc, nimiq, keyPair: KEYPAIR, network: "main" }).pay({ to: `SAVE-${code}`, luna: NIM(2000), payoutId: "bounty-81" });
    expect(built).toEqual([
      ["basic", `addr(${PAYOUT})`, `addr(${USER})`, NIM(1400), 0n, 1_000, 24],
      ["addStake", `addr(${PAYOUT})`, `addr(${USER})`, NIM(600), 0n, 1_000, 24],
    ]);
    expect(sent).toEqual([`hex-${"1".padStart(64, "0")}`, `hex-${"2".padStart(64, "0")}`]);
    expect(r).toMatchObject({ walletLuna: NIM(1400), growLuna: NIM(600), walletTx: "1".padStart(64, "0"), growTx: "2".padStart(64, "0"), repeated: false });
    expect(receipts).toEqual([{ code, payoutId: "bounty-81", walletTx: "1".padStart(64, "0"), growTx: "2".padStart(64, "0") }]);
  });

  it("sends one payment when nothing goes to Grow, and says why", async () => {
    const { nimiq, built } = fakeNimiq();
    const { rpc } = fakeRpc();
    const { api } = fakeApi({ walletLuna: NIM(10), growLuna: 0n, reason: "no-stake" });
    const r = await createSavePayer({ api, rpc, nimiq, keyPair: KEYPAIR, network: "test" }).pay({ to: `SAVE-${await realCode()}`, luna: NIM(10), payoutId: "p1", memo: "Arcade prize" });
    expect(built).toEqual([["basicWithData", `addr(${PAYOUT})`, `addr(${USER})`, "Arcade prize", NIM(10), 0n, 1_000, 5]]);
    expect(r).toMatchObject({ growTx: null, growLuna: 0n, reason: "no-stake" });
  });

  it("pays a plain address without asking the Errand API", async () => {
    const { nimiq, built } = fakeNimiq();
    const { rpc } = fakeRpc();
    const r = await createSavePayer({ rpc, nimiq, keyPair: KEYPAIR, network: "main" }).pay({ to: USER, luna: NIM(5), payoutId: "p2" });
    expect(built).toEqual([["basic", `addr(${PAYOUT})`, `addr(${USER})`, NIM(5), 0n, 1_000, 24]]);
    expect(r).toMatchObject({ address: USER, walletLuna: NIM(5), growTx: null });
  });

  it("never pays twice: a retry with the same payoutId resends the same signed transactions", async () => {
    const { nimiq, built } = fakeNimiq();
    const { rpc, sent, onChain } = fakeRpc();
    const { api } = fakeApi({ walletLuna: NIM(1400), growLuna: NIM(600) });
    const log = memoryPayoutLog();
    const payer = createSavePayer({ api, rpc, nimiq, keyPair: KEYPAIR, network: "main", log });
    const code = await realCode();
    await payer.pay({ to: `SAVE-${code}`, luna: NIM(2000), payoutId: "bounty-81" });
    onChain.add("1".padStart(64, "0")); // the wallet part made it; the add-stake didn't
    const again = await payer.pay({ to: `SAVE-${code}`, luna: NIM(2000), payoutId: "bounty-81" });
    expect(built).toHaveLength(2);
    expect(sent).toEqual([`hex-${"1".padStart(64, "0")}`, `hex-${"2".padStart(64, "0")}`, `hex-${"2".padStart(64, "0")}`]);
    expect(again).toMatchObject({ repeated: true, walletLuna: NIM(1400), growLuna: NIM(600) });
  });

  it("reports again while a transaction is still pending", async () => {
    const { nimiq } = fakeNimiq();
    const { rpc } = fakeRpc();
    const { api, receipts } = fakeApi({ walletLuna: NIM(1), growLuna: NIM(1) }, [{ walletTx: "recorded", growTx: "pending" }, { walletTx: "recorded", growTx: "recorded" }]);
    await createSavePayer({ api, rpc, nimiq, keyPair: KEYPAIR, network: "main", sleep: async () => undefined }).pay({ to: `SAVE-${await realCode()}`, luna: NIM(2), payoutId: "p3" });
    expect(receipts).toHaveLength(2);
  });

  it("refuses bad input before signing anything", async () => {
    const { nimiq, built } = fakeNimiq();
    const { rpc } = fakeRpc();
    const payer = createSavePayer({ rpc, nimiq, keyPair: KEYPAIR, network: "main" });
    await expect(payer.pay({ to: "not an address", luna: 1n, payoutId: "p" })).rejects.toThrow(/save code \(SAVE-…\) or a Nimiq address/);
    await expect(payer.pay({ to: USER, luna: 0n, payoutId: "p" })).rejects.toThrow(RangeError);
    await expect(payer.pay({ to: USER, luna: 1n, payoutId: "has spaces" })).rejects.toThrow(RangeError);
    await expect(payer.pay({ to: USER, luna: 1n, payoutId: "p", memo: "x".repeat(65) })).rejects.toThrow(/64 bytes/);
    await expect(payer.pay({ to: `SAVE-${await realCode()}`, luna: 1n, payoutId: "p" })).rejects.toBeInstanceOf(SaveApiError);
    expect(built).toEqual([]);
  });
});

describe("createSaveApi", () => {
  it("sends the app key and converts luna to bigint", async () => {
    let seen: { url: string; auth: string | null } | undefined;
    const api = createSaveApi({
      apiUrl: "https://api.errand.example/",
      apiKey: "rk_save_x",
      fetch: async (url, init) => {
        seen = { url: String(url), auth: new Headers(init?.headers).get("authorization") };
        return Response.json({ code: "SAVE-7KQ2XMP", address: USER, savePercent: 30, wallet: { luna: "140000000" }, grow: { luna: "60000000", staker: USER }, reason: null });
      },
    });
    expect(await api.split("7KQ2XMP", NIM(2000))).toEqual({ code: "SAVE-7KQ2XMP", address: USER, savePercent: 30, walletLuna: NIM(1400), growLuna: NIM(600), staker: USER, reason: null });
    expect(seen).toEqual({ url: "https://api.errand.example/v1/save/split?code=7KQ2XMP&luna=200000000", auth: "Bearer rk_save_x" });
  });

  it("turns API errors into SaveApiError with the status", async () => {
    const api = createSaveApi({ apiUrl: "https://x", apiKey: "k", fetch: async () => Response.json({ error: { message: "No active save code like that." } }, { status: 404 }) });
    await expect(api.split("7KQ2XMP", 1n)).rejects.toMatchObject({ status: 404, message: "No active save code like that." });
  });
});
