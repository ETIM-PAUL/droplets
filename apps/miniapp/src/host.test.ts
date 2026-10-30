import { describe, expect, it } from "vitest";
import { connectHost, lunaToNim, type HostSdk } from "./host";

const sdkWith = (provider: unknown, network: "mainnet" | "testnet" | null = "testnet"): HostSdk => ({
  init: (async () => {
    if (!provider) throw new Error("timeout");
    return provider;
  }) as HostSdk["init"],
  getHostFiat: () => "KES",
  getHostLanguage: () => "en",
  getHostNetwork: () => network ?? undefined,
});

describe("lunaToNim", () => {
  it("formats without floats", () => {
    expect(lunaToNim(0)).toBe("0");
    expect(lunaToNim(250_000)).toBe("2.5");
    expect(lunaToNim(1)).toBe("0.00001");
    expect(lunaToNim(123_456_789)).toBe("1234.56789");
  });
});

describe("connectHost", () => {
  it("reports outside-nimiq-pay when the provider never appears", async () => {
    expect(await connectHost(sdkWith(null))).toEqual({ status: "outside-nimiq-pay" });
  });

  it("returns account, balance and host context", async () => {
    const provider = { listAccounts: async () => ["NQ01 TEST"], getBalance: async () => 500_000 };
    expect(await connectHost(sdkWith(provider))).toEqual({
      status: "ready",
      network: "testnet",
      language: "en",
      fiat: "KES",
      address: "NQ01 TEST",
      balanceNim: "5",
      accounts: [{ address: "NQ01 TEST", nim: "5" }],
    });
  });

  it("adds up every account, as on the tester's phone (empty first account, funded second)", async () => {
    const balances: Record<string, number> = { NQ72: 0, NQ34: 1_597_459_620 };
    const provider = { listAccounts: async () => ["NQ72", "NQ34"], getBalance: async (a: string) => balances[a]! };
    const s = await connectHost(sdkWith(provider));
    expect(s).toMatchObject({ balanceNim: "15974.5962", accounts: [{ address: "NQ72", nim: "0" }, { address: "NQ34", nim: "15974.5962" }] });
  });

  it("falls back to mainnet on older hosts", async () => {
    const provider = { listAccounts: async () => ["NQ01"], getBalance: async () => 0 };
    const s = await connectHost(sdkWith(provider, null));
    expect(s.status === "ready" && s.network).toBe("mainnet");
  });

  it("waits instead of failing while Nimiq Pay is still connecting", async () => {
    const notReady = Object.assign(new Error("Nimiq network is not ready"), { name: "NimiqProviderError", type: "NETWORK_ERROR" });
    const provider = { listAccounts: async () => ["NQ01"], getBalance: async () => { throw notReady; } };
    const s = await connectHost(sdkWith(provider));
    expect(s).toMatchObject({ status: "ready", address: "NQ01", balanceNim: null });
  });

  it("shows a next step when there is no account", async () => {
    const provider = { listAccounts: async () => [], getBalance: async () => 0 };
    const s = await connectHost(sdkWith(provider));
    expect(s.status).toBe("error");
  });

  it("turns wallet failures into a user message", async () => {
    const provider = { listAccounts: async () => { throw new Error("boom"); }, getBalance: async () => 0 };
    const s = await connectHost(sdkWith(provider));
    expect(s).toEqual({ status: "error", message: expect.stringContaining("reopen") });
  });
});
