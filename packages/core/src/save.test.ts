import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { formatNimiqAddress, nimiqAddressBytes } from "./nimiq-address";
import { createNimiqRpc, NimiqRpcError } from "./nimiq-rpc";
import {
  checkWithdrawal,
  formatSaveCode,
  formatSaveMessage,
  lunaToNimString,
  MIN_STAKE_LUNA,
  newSaveCode,
  nimiqAddressFromPublicKey,
  nimiqMessageHash,
  nimStringToLuna,
  parseSaveCode,
  parseSaveMessage,
  releaseBlock,
  splitPayout,
  type StakerState,
} from "./save";

// Cross-checked against @nimiq/core 2.23.0 (KeyPair.toAddress) when this was written.
const FIXTURE = { publicKey: "eb49ff0ce02e6cd5408e2939590e147a95faafe6de9de404c820e5bb3b36a719", address: "NQ23 4CTV GPEU C004 7USS EPFM RQ5C METQ EMDP" };
const NIM = (n: number) => BigInt(n) * 100_000n;
const staker = (over: Partial<StakerState> = {}): StakerState => ({ active: NIM(500), inactive: 0n, inactiveFrom: null, retired: 0n, delegation: "NQ26 0000 0000 02A5 YAK7 4QNF 9MH0 TE2B GVRU", ...over });

describe("save codes", () => {
  it("makes codes that parse back, with or without the prefix", () => {
    for (let i = 0; i < 200; i++) {
      const code = newSaveCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{7}$/);
      expect(parseSaveCode(formatSaveCode(code))).toEqual({ ok: true, value: code });
      expect(parseSaveCode(` save ${code.toLowerCase().slice(0, 3)} ${code.slice(3)} `)).toEqual({ ok: true, value: code });
    }
  });

  it("catches every single-character typo", () => {
    const code = newSaveCode(() => new Uint8Array([7, 20, 22, 2, 29, 19]));
    for (let i = 0; i < code.length; i++) {
      for (const c of "0123456789ABCDEFGHJKMNPQRSTVWXYZ") {
        if (c === code[i]) continue;
        const typo = code.slice(0, i) + c + code.slice(i + 1);
        expect(parseSaveCode(typo).ok, typo).toBe(false);
      }
    }
  });

  it("reads O as 0 and I or L as 1, and refuses other shapes", () => {
    const code = newSaveCode(() => new Uint8Array([0, 1, 0, 1, 0, 1]));
    expect(code.slice(0, 6)).toBe("010101");
    expect(parseSaveCode(`OIOLO1${code[6]}`)).toEqual({ ok: true, value: code });
    for (const bad of ["", "SAVE-", "12345", "SAVE-1234567890", "NQ07 0000 0000 0000 0000 0000 0000 0000 0000", "ABCDEFU"]) {
      expect(parseSaveCode(bad).ok, bad).toBe(false);
    }
  });
});

describe("signed rules", () => {
  const set = { action: "set" as const, address: FIXTURE.address, savePercent: 30, time: "2026-11-04T15:20:00.000Z", nonce: "9f2c4d1e8a7b6c5d" };

  it("round-trips the exact text the user signs", () => {
    const text = formatSaveMessage(set);
    expect(text).toBe(`Errand save code\nAction: set\nAddress: ${FIXTURE.address}\nSave: 30%\nTime: 2026-11-04T15:20:00.000Z\nNonce: 9f2c4d1e8a7b6c5d`);
    expect(parseSaveMessage(text)).toEqual({ ok: true, value: set });
    const revoke = { action: "revoke" as const, address: FIXTURE.address, time: set.time, nonce: set.nonce };
    expect(parseSaveMessage(formatSaveMessage(revoke))).toEqual({ ok: true, value: revoke });
  });

  it("refuses anything that reads differently from what formatSaveMessage writes", () => {
    const text = formatSaveMessage(set);
    for (const bad of [
      text.replace("Save: 30%", "Save: 030%"),
      text.replace("Save: 30%", "Save: 101%"),
      text.replace(FIXTURE.address, FIXTURE.address.toLowerCase()),
      text.replace(FIXTURE.address, FIXTURE.address.replace("4CTV", "4CTW")),
      text.replace("Nonce: 9f2c4d1e8a7b6c5d", "Nonce: short"),
      text + "\nExtra: line",
      text.replace("Errand save code", "Errand Save code"),
      text.replace("Action: set", "Action: delete"),
      formatSaveMessage({ ...set, action: "revoke" }).replace("Time", "Save: 30%\nTime"),
    ]) {
      expect(parseSaveMessage(bad).ok, bad).toBe(false);
    }
  });

  it("hashes like Nimiq Pay's sign(), and a node:crypto Ed25519 signature over it verifies", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const hash = nimiqMessageHash("héllo");
    // Nimiq Pay hashes the prefix with the message's byte length (6 here, not 5 characters).
    const raw = new TextEncoder().encode("\x16Nimiq Signed Message:\n6héllo");
    expect(Buffer.from(hash).toString("hex")).toBe(createHash("sha256").update(raw).digest("hex"));
    const sig = sign(null, hash, privateKey);
    expect(verify(null, hash, publicKey, sig)).toBe(true);
  });

  it("derives the address Nimiq derives from a public key", () => {
    expect(nimiqAddressFromPublicKey(FIXTURE.publicKey)).toBe(FIXTURE.address);
    expect(() => nimiqAddressFromPublicKey("abcd")).toThrow();
  });

  it("encodes and decodes address bytes", () => {
    const bytes = nimiqAddressBytes(FIXTURE.address);
    expect(bytes).toHaveLength(20);
    expect(formatNimiqAddress(bytes)).toBe(FIXTURE.address);
    expect(formatNimiqAddress(new Uint8Array(20))).toBe("NQ07 0000 0000 0000 0000 0000 0000 0000 0000");
  });
});

describe("splitting a payment", () => {
  const open = { open: true as const, staker: staker() };

  it("sends the rule's share to Grow and the rest to the wallet", () => {
    expect(splitPayout(NIM(2000), 30, open)).toEqual({ wallet: NIM(1400), grow: NIM(600), reason: null });
    // floor: the wallet gets the odd luna.
    expect(splitPayout(101n, 30, open)).toEqual({ wallet: 71n, grow: 30n, reason: null });
    expect(splitPayout(NIM(10), 100, open)).toEqual({ wallet: 0n, grow: NIM(10), reason: null });
    expect(splitPayout(NIM(10), 0, open)).toEqual({ wallet: NIM(10), grow: 0n, reason: null });
  });

  it("falls back to the wallet when Grow can't take it", () => {
    expect(splitPayout(NIM(10), 30, { open: false, reason: "no-stake" })).toEqual({ wallet: NIM(10), grow: 0n, reason: "no-stake" });
    expect(splitPayout(NIM(10), 30, { open: false, reason: "validator-gone" }).reason).toBe("validator-gone");
    // Everything already retired: a small add would leave the stake under 100 NIM, which the protocol refuses.
    const emptied = { open: true as const, staker: staker({ active: 0n, retired: NIM(500) }) };
    expect(splitPayout(NIM(10), 30, emptied)).toEqual({ wallet: NIM(10), grow: 0n, reason: "below-minimum" });
    expect(splitPayout(NIM(400), 30, emptied)).toEqual({ wallet: NIM(280), grow: NIM(120), reason: null });
  });

  it("refuses nonsense", () => {
    expect(() => splitPayout(0n, 30, open)).toThrow();
    expect(() => splitPayout(NIM(1), 30.5, open)).toThrow();
    expect(() => splitPayout(NIM(1), 101, open)).toThrow();
  });
});

describe("withdrawing from Grow", () => {
  it("leaves 0 or at least 100 NIM", () => {
    expect(checkWithdrawal(staker(), NIM(500))).toEqual({ ok: true, value: { newActive: 0n } });
    expect(checkWithdrawal(staker(), NIM(400))).toEqual({ ok: true, value: { newActive: NIM(100) } });
    expect(checkWithdrawal(staker(), NIM(450)).ok).toBe(false);
    expect(checkWithdrawal(staker(), NIM(501)).ok).toBe(false);
    expect(checkWithdrawal(staker(), 0n).ok).toBe(false);
    expect(MIN_STAKE_LUNA).toBe(NIM(100));
  });

  it("releases one epoch after the lock-up starts, or after the validator's jail", () => {
    expect(releaseBlock(65_966_400)).toBe(65_966_400 + 43_201);
    expect(releaseBlock(65_966_400, 65_950_000)).toBe(65_950_000 + 8 * 43_200 + 1);
  });
});

describe("NIM amounts", () => {
  it("converts without floats", () => {
    expect(lunaToNimString(123_456_789n)).toBe("1234.56789");
    expect(lunaToNimString(NIM(100))).toBe("100");
    expect(nimStringToLuna("1234.56789")).toEqual({ ok: true, value: 123_456_789n });
    expect(nimStringToLuna("0.1")).toEqual({ ok: true, value: 10_000n });
    for (const bad of ["", "1.234567", "-1", "1e5", "abc"]) expect(nimStringToLuna(bad).ok, bad).toBe(false);
  });
});

describe("Nimiq RPC client", () => {
  const rpc = (answer: unknown) =>
    createNimiqRpc({ url: "https://rpc.example", fetch: async () => new Response(JSON.stringify(answer), { status: 200 }) });

  it("reads a staker, and null when there is none", async () => {
    const s = await rpc({ jsonrpc: "2.0", id: 1, result: { data: { balance: 327531117193, inactiveBalance: 0, inactiveFrom: null, retiredBalance: 0, delegation: "NQ49 N8MB XYCR XBUP 404C KXKK L49M A7BT F082" } } }).staker(FIXTURE.address);
    expect(s).toEqual({ active: 327531117193n, inactive: 0n, inactiveFrom: null, retired: 0n, delegation: "NQ49 N8MB XYCR XBUP 404C KXKK L49M A7BT F082" });
    // The node's exact words, seen on rpc.nimiqwatch.com on 2026-11-04.
    const none = rpc({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Internal error", data: `No staker with address: ${FIXTURE.address}` } });
    expect(await none.staker(FIXTURE.address)).toBeNull();
    const gone = rpc({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Internal error", data: "Transaction not found: 00" } });
    expect(await gone.transaction("00")).toBeNull();
  });

  it("reads which chain the node follows", async () => {
    expect(await rpc({ jsonrpc: "2.0", id: 1, result: { data: { network: "TestAlbatross", number: 15894144, type: "micro" } } }).network()).toBe("TestAlbatross");
  });

  it("throws other node errors and network failures", async () => {
    await expect(rpc({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params", data: "Unknown format" } }).staker("x")).rejects.toBeInstanceOf(NimiqRpcError);
    const down = createNimiqRpc({ url: "https://rpc.example", fetch: async () => { throw new TypeError("fetch failed"); } });
    await expect(down.blockNumber()).rejects.toThrow(/Couldn't reach the Nimiq network/);
  });
});
