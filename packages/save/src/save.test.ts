import { describe, expect, it, vi } from "vitest";
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

function fakeRpc(follows = "MainAlbatross") {
  const sent: string[] = [];
  const onChain = new Set<string>();
  return {
    sent,
    onChain,
    rpc: {
      network: async () => follows,
      blockNumber: async () => 1_000,
      sendRawTransaction: async (hex: string) => (sent.push(hex), hex.slice(4)),
      transaction: async (hash: string) => (onChain.has(hash) ? ({ hash } as never) : null),
    },
  };
}

function fakeApi(
  split: { walletLuna: bigint; growLuna: bigint; reason?: string | null },
  receiptAnswers: Record<string, string>[] = [{}],
  byAddress: (address: string, luna: bigint) => Promise<{ walletLuna: bigint; growLuna: bigint; reason?: string | null }> = async () => split,
) {
  const receipts: unknown[] = [];
  const splitCalls: (string | undefined)[] = [];
  const addressCalls: string[] = [];
  return {
    receipts,
    splitCalls,
    addressCalls,
    api: {
      split: async (code: string, _luna: bigint, payoutId?: string) => (splitCalls.push(payoutId), { code: `SAVE-${code}`, address: USER, savePercent: 30, staker: USER, reason: null, ...split }) as never,
      splitAddress: async (address: string, luna: bigint) => (addressCalls.push(address), { code: null, address, savePercent: 30, staker: address, reason: null, ...(await byAddress(address, luna)) }) as never,
      spend: async () => {
        throw new Error("unused");
      },
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
    const { api, receipts, splitCalls } = fakeApi({ walletLuna: NIM(1400), growLuna: NIM(600) });
    const code = await realCode();
    const r = await createSavePayer({ api, rpc, nimiq, keyPair: KEYPAIR, network: "main" }).pay({ to: `SAVE-${code}`, luna: NIM(2000), payoutId: "bounty-81" });
    expect(splitCalls).toEqual(["bounty-81"]);
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
    const { rpc } = fakeRpc("TestAlbatross");
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

  it("pays a plain address straight into its Grow when asked", async () => {
    const { nimiq, built } = fakeNimiq();
    const { rpc } = fakeRpc();
    const payer = createSavePayer({ rpc, nimiq, keyPair: KEYPAIR, network: "main" });
    const r = await payer.pay({ to: USER, luna: NIM(1000), payoutId: "prize-2026-11-09", into: "grow" });
    expect(built).toEqual([["addStake", `addr(${PAYOUT})`, `addr(${USER})`, NIM(1000), 0n, 1_000, 24]]);
    expect(r).toMatchObject({ address: USER, walletTx: null, walletLuna: 0n, growLuna: NIM(1000), growTx: "1".padStart(64, "0") });
    await expect(payer.pay({ to: USER, luna: NIM(1), payoutId: "p3", into: "grow", memo: "hi" })).rejects.toThrow(/memo/);
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

  it("signs nothing when the node follows the other network, which would accept the payment and never land it", async () => {
    const { nimiq, built } = fakeNimiq();
    const { rpc, sent } = fakeRpc("TestAlbatross");
    const payer = createSavePayer({ rpc, nimiq, keyPair: KEYPAIR, network: "main" });
    await expect(payer.pay({ to: USER, luna: NIM(5), payoutId: "p4" })).rejects.toThrow(/follows TestAlbatross.*Nothing was sent/);
    await expect(payer.checkNetwork()).rejects.toThrow(/follows TestAlbatross/);
    expect(built).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("checks the network again after the node couldn't be reached", async () => {
    const { nimiq } = fakeNimiq();
    const { rpc } = fakeRpc();
    const network = vi.fn().mockRejectedValueOnce(new Error("Couldn't reach the Nimiq network")).mockResolvedValue("MainAlbatross");
    const payer = createSavePayer({ rpc: { ...rpc, network }, nimiq, keyPair: KEYPAIR, network: "main" });
    await expect(payer.checkNetwork()).rejects.toThrow(/Couldn't reach/);
    await expect(payer.pay({ to: USER, luna: NIM(5), payoutId: "p5" })).resolves.toMatchObject({ walletLuna: NIM(5) });
    await payer.pay({ to: USER, luna: NIM(5), payoutId: "p6" });
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("treats only a real 'already known' error as sent: a node error about something unknown still fails", async () => {
    const { nimiq } = fakeNimiq();
    const { rpc } = fakeRpc();
    const failWith = (data: string) => async () => {
      throw Object.assign(new Error("Internal error"), { data });
    };
    const unknown = createSavePayer({ rpc: { ...rpc, sendRawTransaction: failWith("Unknown sender account") }, nimiq, keyPair: KEYPAIR, network: "main" });
    await expect(unknown.pay({ to: USER, luna: NIM(1), payoutId: "p7" })).rejects.toThrow(/Internal error/);
    const known = createSavePayer({ rpc: { ...rpc, sendRawTransaction: failWith("Transaction already known") }, nimiq, keyPair: KEYPAIR, network: "main" });
    await expect(known.pay({ to: USER, luna: NIM(1), payoutId: "p8" })).resolves.toMatchObject({ walletLuna: NIM(1) });
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

describe("paying the address you already pay", () => {
  it("splits it for a saver who allowed the app, and reports by address", async () => {
    const { nimiq, built } = fakeNimiq();
    const { rpc } = fakeRpc();
    const { api, receipts, addressCalls } = fakeApi({ walletLuna: NIM(1400), growLuna: NIM(600) });
    const r = await createSavePayer({ api, rpc, nimiq, keyPair: KEYPAIR, network: "main" }).pay({ to: USER, luna: NIM(2000), payoutId: "bounty-81" });
    expect(addressCalls).toEqual([USER]);
    expect(built).toEqual([
      ["basic", `addr(${PAYOUT})`, `addr(${USER})`, NIM(1400), 0n, 1_000, 24],
      ["addStake", `addr(${PAYOUT})`, `addr(${USER})`, NIM(600), 0n, 1_000, 24],
    ]);
    expect(r).toMatchObject({ address: USER, walletLuna: NIM(1400), growLuna: NIM(600) });
    expect(receipts).toEqual([{ address: USER, payoutId: "bounty-81", walletTx: "1".padStart(64, "0"), growTx: "2".padStart(64, "0") }]);
  });

  it("pays everyone else, or anyone when Errand doesn't answer, in one normal payment with nothing to report", async () => {
    for (const answer of [async () => ({ walletLuna: NIM(5), growLuna: 0n }), async () => Promise.reject(new Error("timed out"))]) {
      const { nimiq, built } = fakeNimiq();
      const { rpc } = fakeRpc();
      const { api, receipts } = fakeApi({ walletLuna: 0n, growLuna: 0n }, [{}], answer);
      const r = await createSavePayer({ api, rpc, nimiq, keyPair: KEYPAIR, network: "main" }).pay({ to: USER, luna: NIM(5), payoutId: "p1", memo: "Prize" });
      expect(built).toEqual([["basicWithData", `addr(${PAYOUT})`, `addr(${USER})`, "Prize", NIM(5), 0n, 1_000, 24]]);
      expect(r).toMatchObject({ walletLuna: NIM(5), growLuna: 0n, reason: null });
      expect(receipts).toEqual([]);
    }
  });

  it("records why nothing was saved for a saver whose Grow couldn't take it", async () => {
    const { nimiq, built } = fakeNimiq();
    const { rpc } = fakeRpc();
    const { api, receipts } = fakeApi({ walletLuna: NIM(5), growLuna: 0n, reason: "no-stake" });
    const r = await createSavePayer({ api, rpc, nimiq, keyPair: KEYPAIR, network: "main" }).pay({ to: USER, luna: NIM(5), payoutId: "p2" });
    expect(built).toHaveLength(1);
    expect(r.reason).toBe("no-stake");
    expect(receipts).toEqual([{ address: USER, payoutId: "p2", walletTx: "1".padStart(64, "0") }]);
  });

  it("never asks Errand about a refund (into: wallet) or a prize into Grow (into: grow)", async () => {
    const { nimiq } = fakeNimiq();
    const { rpc } = fakeRpc();
    const { api, addressCalls } = fakeApi({ walletLuna: NIM(1), growLuna: NIM(1) });
    const payer = createSavePayer({ api, rpc, nimiq, keyPair: KEYPAIR, network: "main" });
    await payer.pay({ to: USER, luna: NIM(2), payoutId: "refund-1", into: "wallet" });
    await payer.pay({ to: USER, luna: NIM(2), payoutId: "prize-1", into: "grow" });
    expect(addressCalls).toEqual([]);
  });

  it("doesn't fail a sent payment when the saver stopped allowing the app before it was reported", async () => {
    const { nimiq } = fakeNimiq();
    const { rpc } = fakeRpc();
    const { api } = fakeApi({ walletLuna: NIM(1), growLuna: NIM(1) });
    api.receipt = async () => {
      throw new SaveApiError("This address hasn't allowed your app to save for it.", 404);
    };
    await expect(createSavePayer({ api, rpc, nimiq, keyPair: KEYPAIR, network: "main" }).pay({ to: USER, luna: NIM(2), payoutId: "p3" })).resolves.toMatchObject({ growLuna: NIM(1) });
  });
});

describe("spend and save", () => {
  const VALIDATOR = "NQ26 0000 0000 02A5 YAK7 4QNF 9MH0 TE2B GVRU";
  const STAKE = { active: NIM(500), inactive: 0n, inactiveFrom: null, retired: 0n, delegation: VALIDATOR };
  function stakeRpc(staker: typeof STAKE | null, validatorThere = true) {
    const { rpc, ...rest } = fakeRpc();
    return { ...rest, rpc: { ...rpc, staker: async () => staker, validator: async () => (validatorThere ? ({} as never) : null) } };
  }

  it("puts the saved part into the payer's own stake and reports it as spending", async () => {
    const { nimiq, built } = fakeNimiq();
    const { rpc } = stakeRpc(STAKE);
    const { api, receipts } = fakeApi({ walletLuna: 0n, growLuna: 0n });
    const r = await createSavePayer({ api, rpc, nimiq, keyPair: KEYPAIR, network: "main" }).saveFromSpend({ to: USER, luna: NIM(5), payoutId: "order-7-save" });
    expect(built).toEqual([["addStake", `addr(${PAYOUT})`, `addr(${USER})`, NIM(5), 0n, 1_000, 24]]);
    expect(r).toMatchObject({ growLuna: NIM(5), walletLuna: 0n, reason: null });
    expect(receipts).toEqual([{ address: USER, source: "spend", payoutId: "order-7-save", growTx: "1".padStart(64, "0") }]);
  });

  it("gives the saved part back to the wallet when the stake can't take it any more", async () => {
    for (const [staker, validator, reason] of [[null, true, "no-stake"], [STAKE, false, "validator-gone"]] as const) {
      const { nimiq, built } = fakeNimiq();
      const { rpc } = stakeRpc(staker, validator);
      const r = await createSavePayer({ rpc, nimiq, keyPair: KEYPAIR, network: "main" }).saveFromSpend({ to: USER, luna: NIM(5), payoutId: "order-8-save" });
      expect(built).toEqual([["basic", `addr(${PAYOUT})`, `addr(${USER})`, NIM(5), 0n, 1_000, 24]]);
      expect(r).toMatchObject({ walletLuna: NIM(5), growLuna: 0n, reason });
    }
  });

  it("is retry-safe, and needs a node that can read stakes", async () => {
    const { nimiq, built } = fakeNimiq();
    const { rpc } = stakeRpc(STAKE);
    const payer = createSavePayer({ rpc, nimiq, keyPair: KEYPAIR, network: "main" });
    await payer.saveFromSpend({ to: USER, luna: NIM(5), payoutId: "order-9-save" });
    expect(await payer.saveFromSpend({ to: USER, luna: NIM(5), payoutId: "order-9-save" })).toMatchObject({ repeated: true, growLuna: NIM(5) });
    expect(built).toHaveLength(1);
    const { rpc: plain } = fakeRpc();
    await expect(createSavePayer({ rpc: plain, nimiq, keyPair: KEYPAIR, network: "main" }).saveFromSpend({ to: USER, luna: NIM(5), payoutId: "x" })).rejects.toThrow(/rpc.staker/);
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
    await api.split("7KQ2XMP", NIM(2000), "bounty-81");
    expect(seen?.url).toBe("https://api.errand.example/v1/save/split?code=7KQ2XMP&luna=200000000&payoutId=bounty-81");
  });

  it("looks up an address and a spend quote, and reports by address", async () => {
    const seen: { url: string; body?: string }[] = [];
    const answers: unknown[] = [
      { code: null, address: USER, savePercent: 30, wallet: { luna: "140000000" }, grow: { luna: "60000000", staker: USER }, reason: null },
      { address: USER, spendPercent: 5, price: "10000000", save: "500000", total: "10500000", staker: USER, reason: null },
      { growTx: "recorded" },
    ];
    const api = createSaveApi({
      apiUrl: "https://api.errand.example",
      apiKey: "rk_save_x",
      fetch: async (url, init) => (seen.push({ url: String(url), body: init?.body as string | undefined }), Response.json(answers.shift())),
    });
    expect(await api.splitAddress(USER, NIM(2000), "bounty-81")).toEqual({ code: null, address: USER, savePercent: 30, walletLuna: NIM(1400), growLuna: NIM(600), staker: USER, reason: null });
    expect(await api.spend(USER, NIM(100))).toEqual({ address: USER, spendPercent: 5, priceLuna: NIM(100), saveLuna: NIM(5), totalLuna: NIM(105), reason: null });
    await api.receipt({ address: USER, source: "spend", payoutId: "order-7-save", growTx: "f".repeat(64) });
    const a = encodeURIComponent(USER);
    expect(seen.map((x) => x.url)).toEqual([
      `https://api.errand.example/v1/save/split?address=${a}&luna=200000000&payoutId=bounty-81`,
      `https://api.errand.example/v1/save/spend?address=${a}&luna=10000000`,
      "https://api.errand.example/v1/save/receipts",
    ]);
    expect(JSON.parse(seen[2]!.body!)).toEqual({ address: USER, source: "spend", payoutId: "order-7-save", growTx: "f".repeat(64) });
  });

  it("turns API errors into SaveApiError with the status", async () => {
    const api = createSaveApi({ apiUrl: "https://x", apiKey: "k", fetch: async () => Response.json({ error: { message: "No active save code like that." } }, { status: 404 }) });
    await expect(api.split("7KQ2XMP", 1n)).rejects.toMatchObject({ status: 404, message: "No active save code like that." });
  });
});
