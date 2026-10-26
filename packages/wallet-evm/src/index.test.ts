import { WalletError } from "@railkit/core";
import { describe, expect, it } from "vitest";
import { createEvmExecutor, encodeTransfer, toBaseUnits, type Eip1193Like, type TokenConfig } from "./index";

// Fake address: tests never ship real token addresses.
const TOKEN: TokenConfig = { chain: "polygon", chainId: 137, symbol: "USDT", address: "0x" + "11".repeat(20), decimals: 6 };
const TO = "0x" + "ab".repeat(20);
const HASH = "0x" + "cd".repeat(32);
const step = { kind: "evm-transfer", chain: "polygon", to: TO, amount: { amount: "12.5", currency: "USDT" } } as const;

function fake(handlers: Record<string, (p?: unknown[]) => unknown>) {
  const calls: { method: string; params?: unknown[] }[] = [];
  const p: Eip1193Like = {
    async request(a) {
      calls.push(a);
      const h = handlers[a.method];
      if (!h) throw new Error("unexpected " + a.method);
      return h(a.params);
    },
  };
  return { p, calls };
}
const ok = { eth_chainId: () => "0x89", eth_requestAccounts: () => ["0x" + "99".repeat(20)], eth_sendTransaction: () => HASH };

describe("encoding", () => {
  it("builds ERC-20 transfer calldata", () => {
    const d = encodeTransfer(TO, 12_500_000n);
    expect(d.startsWith("0xa9059cbb")).toBe(true);
    expect(d).toHaveLength(2 + 8 + 64 + 64);
    expect(d.endsWith("bebc20")).toBe(true); // 12,500,000 = 0xbebc20
  });
  it("converts to base units exactly and refuses extra precision", () => {
    expect(toBaseUnits("12.5", 6)).toBe(12_500_000n);
    expect(() => toBaseUnits("0.0000001", 6)).toThrow(WalletError);
  });
  it("rejects bad addresses", () => {
    expect(() => encodeTransfer("0x123", 1n)).toThrow(WalletError);
  });
});

describe("createEvmExecutor", () => {
  it("sends the transfer to the token contract and returns the hash", async () => {
    const { p, calls } = fake(ok);
    const r = await createEvmExecutor(p, [TOKEN]).execute(step);
    expect(r.ref).toBe(HASH);
    const tx = calls.find((c) => c.method === "eth_sendTransaction")!.params![0] as { to: string; data: string };
    expect(tx.to).toBe(TOKEN.address);
    expect(tx.data).toContain(TO.slice(2));
  });

  it("sends nothing on the wrong network", async () => {
    const { p, calls } = fake({ ...ok, eth_chainId: () => "0x1" });
    await expect(createEvmExecutor(p, [TOKEN]).execute(step)).rejects.toMatchObject({ kind: "failed" });
    expect(calls.some((c) => c.method === "eth_sendTransaction")).toBe(false);
  });

  it("refuses an unconfigured token", async () => {
    const { p } = fake(ok);
    await expect(createEvmExecutor(p, []).execute(step)).rejects.toMatchObject({ kind: "failed" });
  });

  it("maps 4001 to rejected and other post-send errors to unknown", async () => {
    const reject = fake({ ...ok, eth_sendTransaction: () => { throw Object.assign(new Error("no"), { code: 4001 }); } });
    await expect(createEvmExecutor(reject.p, [TOKEN]).execute(step)).rejects.toMatchObject({ kind: "rejected" });
    const flaky = fake({ ...ok, eth_sendTransaction: () => { throw Object.assign(new Error("timeout"), { code: -32603 }); } });
    await expect(createEvmExecutor(flaky.p, [TOKEN]).execute(step)).rejects.toMatchObject({ kind: "unknown" });
  });

  it("treats a missing hash as unknown", async () => {
    const { p } = fake({ ...ok, eth_sendTransaction: () => undefined });
    await expect(createEvmExecutor(p, [TOKEN]).execute(step)).rejects.toMatchObject({ kind: "unknown" });
  });
});
