import { WalletError } from "@railkit/core";
import { describe, expect, it } from "vitest";
import { classifyNimiqError, createNimiqExecutor, createNimiqSaver, nimToLuna, type NimiqProviderLike, type NimiqSaverProvider } from "./index";

const INVOICE = "lnbc1...";
const provider = (over: Partial<NimiqProviderLike> = {}): NimiqProviderLike => ({
  payLightningInvoice: async () => ({ hash: "abc", swapId: "swap1" }),
  sendBasicTransaction: async () => "serialized-tx",
  ...over,
});
const err = (type: string, message = "x") => Object.assign(new Error(message), { type });

describe("nimToLuna", () => {
  it("converts exactly", () => {
    expect(nimToLuna("1")).toBe(100_000);
    expect(nimToLuna("2.5")).toBe(250_000);
    expect(nimToLuna("0.00001")).toBe(1);
  });
  it("rejects sub-luna precision and zero", () => {
    expect(() => nimToLuna("0.000001")).toThrow(WalletError);
    expect(() => nimToLuna("0")).toThrow(WalletError);
  });
});

describe("createNimiqExecutor", () => {
  it("pays an invoice and returns hash and swap id", async () => {
    const r = await createNimiqExecutor(provider()).execute({ kind: "pay-lightning-invoice", invoice: INVOICE });
    expect(r.ref).toBe("abc:swap1");
  });

  it("sends NIM in luna", async () => {
    let seen: unknown;
    const ex = createNimiqExecutor(provider({ sendBasicTransaction: async (tx) => ((seen = tx), "tx") }));
    await ex.execute({ kind: "send-nim", to: "NQ00 TEST", amount: { amount: "2.5", currency: "NIM" } });
    expect(seen).toEqual({ recipient: "NQ00 TEST", value: 250_000 });
  });

  it("refuses a non-NIM amount before calling the wallet", async () => {
    let called = false;
    const ex = createNimiqExecutor(provider({ sendBasicTransaction: async () => ((called = true), "tx") }));
    await expect(ex.execute({ kind: "send-nim", to: "NQ", amount: { amount: "1", currency: "USDT" } })).rejects.toMatchObject({ kind: "failed" });
    expect(called).toBe(false);
  });

  it("refuses step kinds it doesn't run", async () => {
    await expect(
      createNimiqExecutor(provider()).execute({ kind: "evm-transfer", chain: "polygon", to: "0x", amount: { amount: "1", currency: "USDT" } }),
    ).rejects.toMatchObject({ kind: "failed" });
  });

  it("maps a declined dialog to rejected", async () => {
    const ex = createNimiqExecutor(provider({ payLightningInvoice: async () => { throw err("PERMISSION_DENIED", "denied"); } }));
    await expect(ex.execute({ kind: "pay-lightning-invoice", invoice: INVOICE })).rejects.toMatchObject({ kind: "rejected" });
  });
});

describe("network readiness", () => {
  const fast = { consensusWaitMs: 3, pollMs: 1, sleep: async () => {} };

  it("waits for Nimiq Pay to connect, then pays", async () => {
    let checks = 0;
    let paid = false;
    const ex = createNimiqExecutor(
      provider({ isConsensusEstablished: async () => ++checks >= 2, payLightningInvoice: async () => ((paid = true), { hash: "h", swapId: "s" }) }),
      fast,
    );
    await ex.execute({ kind: "pay-lightning-invoice", invoice: INVOICE });
    expect(paid).toBe(true);
  });

  it("refuses to start a payment while Nimiq Pay isn't connected", async () => {
    let paid = false;
    const ex = createNimiqExecutor(
      provider({ isConsensusEstablished: async () => false, payLightningInvoice: async () => ((paid = true), { hash: "h", swapId: "s" }) }),
      fast,
    );
    await expect(ex.execute({ kind: "pay-lightning-invoice", invoice: INVOICE })).rejects.toMatchObject({ kind: "failed", message: expect.stringMatching(/isn't connected/) });
    expect(paid).toBe(false);
  });
});

describe("classifyNimiqError", () => {
  it("treats uncertain and unfamiliar errors as unknown, never as safe to retry", () => {
    for (const type of ["TRANSACTION_OUTCOME_UNKNOWN", "NETWORK_ERROR", "INTERNAL_ERROR", "UNKNOWN_ERROR", "SOMETHING_NEW", ""]) {
      expect(classifyNimiqError(err(type)).kind).toBe("unknown");
    }
    expect(classifyNimiqError(new Error("plain")).kind).toBe("unknown");
  });
  it("treats a timeout as unknown even when the type says nothing was sent", () => {
    const e = classifyNimiqError(Object.assign(new Error("Operation timed out after 30000 milliseconds"), { type: "INVALID_TRANSACTION", code: -32602 }));
    expect(e.kind).toBe("unknown");
    expect(e.message).toContain("[INVALID_TRANSACTION -32602]");
  });

  it("only calls an error failed when nothing could have been sent", () => {
    expect(classifyNimiqError(err("INVALID_TRANSACTION")).kind).toBe("failed");
  });
  it("tells the user to check history on a duplicate", () => {
    const e = classifyNimiqError(err("DUPLICATE_PAYMENT"));
    expect(e.kind).toBe("unknown");
    expect(e.message).toMatch(/wallet history/);
  });
});

describe("createNimiqSaver", () => {
  const saverProvider = (over: Partial<NimiqSaverProvider> = {}) => {
    const calls: [string, unknown][] = [];
    const p: NimiqSaverProvider = {
      sign: async (m) => (calls.push(["sign", m]), { publicKey: "ab".repeat(32), signature: "cd".repeat(64) }),
      sendNewStakerTransaction: async (tx) => (calls.push(["newStaker", tx]), "tx1"),
      sendStakeTransaction: async (tx) => (calls.push(["stake", tx]), "tx2"),
      sendSetActiveStakeTransaction: async (tx) => (calls.push(["setActive", tx]), "tx3"),
      sendRetireStakeTransaction: async (tx) => (calls.push(["retire", tx]), "tx4"),
      sendRemoveStakeTransaction: async (tx) => (calls.push(["remove", tx]), "tx5"),
      ...over,
    };
    return { p, calls };
  };

  it("passes luna straight through to each staking call", async () => {
    const { p, calls } = saverProvider();
    const s = createNimiqSaver(p);
    await s.openGrow("NQ26 0000 0000 02A5 YAK7 4QNF 9MH0 TE2B GVRU", 10_000_000n);
    await s.addToGrow(250_000n);
    await s.startWithdrawal(0n);
    await s.retire(10_250_000n);
    await s.remove(10_250_000n);
    expect(calls).toEqual([
      ["newStaker", { delegation: "NQ26 0000 0000 02A5 YAK7 4QNF 9MH0 TE2B GVRU", value: 10_000_000 }],
      ["stake", { value: 250_000 }],
      ["setActive", { newActiveBalance: 0 }],
      ["retire", { retireStake: 10_250_000 }],
      ["remove", { value: 10_250_000 }],
    ]);
  });

  it("signs the rule without waiting for the network", async () => {
    let asked = 0;
    const { p, calls } = saverProvider({ isConsensusEstablished: async () => (asked++, false) });
    const r = await createNimiqSaver(p).signRule("Errand save code\n…");
    expect(r.publicKey).toHaveLength(64);
    expect(calls).toEqual([["sign", "Errand save code\n…"]]);
    expect(asked).toBe(0);
  });

  it("waits for Nimiq Pay to connect before staking, and sends nothing if it never does", async () => {
    const { p, calls } = saverProvider({ isConsensusEstablished: async () => false });
    const s = createNimiqSaver(p, { consensusWaitMs: 2, pollMs: 1, sleep: async () => undefined });
    await expect(s.addToGrow(1n)).rejects.toMatchObject({ kind: "failed" });
    expect(calls).toEqual([]);
  });

  it("refuses zero or out-of-range amounts before calling Nimiq Pay", async () => {
    const { p, calls } = saverProvider();
    const s = createNimiqSaver(p);
    await expect(s.addToGrow(0n)).rejects.toBeInstanceOf(WalletError);
    await expect(s.retire(2n ** 60n)).rejects.toBeInstanceOf(WalletError);
    expect(calls).toEqual([]);
  });

  it("classifies a refusal in Nimiq Pay as rejected", async () => {
    const { p } = saverProvider({ sign: async () => { throw err("PERMISSION_DENIED", "User rejected"); } });
    await expect(createNimiqSaver(p).signRule("x")).rejects.toMatchObject({ kind: "rejected" });
  });
});
