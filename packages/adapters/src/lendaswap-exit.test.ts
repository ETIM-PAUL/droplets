import { bech32 } from "@scure/base";
import { Engine, MemoryOrderStore, parsePaymentInput, type PayIntent, type Step, type WalletExecutor } from "@railkit/core";
import { describe, expect, it } from "vitest";
import { lendaswapExitRoute, type LendaswapLike } from "./lendaswap-exit-route";

const T0 = 1_800_000_000_000;
const ADDRESS = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const HASH = "ab".repeat(32);
const hexBytes = (h: string) => Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16));

function makeInvoice(sats: number, paymentHash: string, hrp = `lnbc${sats * 10}n`) {
  const ts = T0 / 1000;
  const tsWords = Array.from({ length: 7 }, (_, i) => Math.floor(ts / 32 ** (6 - i)) % 32);
  const pw = bech32.toWords(hexBytes(paymentHash));
  const field = [1, Math.floor(pw.length / 32), pw.length % 32, ...pw];
  const x = [6, 0, 2, Math.floor(600 / 32), 600 % 32]; // 10 minute expiry
  return bech32.encode(hrp, [...tsWords, ...field, ...x, ...new Array(104).fill(0)], false);
}

interface FakeOpts {
  statuses?: string[];
  invoice?: (sats: number) => string;
  hashLock?: string;
  sourceSats?: string;
  claimFails?: boolean;
  createFails?: boolean;
}

function fakeClient(f: FakeOpts = {}) {
  const calls = { create: [] as unknown[], claim: 0, polls: 0 };
  const client: LendaswapLike = {
    async createSwap(a) {
      calls.create.push(a);
      if (f.createFails) throw new Error("503");
      const sats = Number(f.sourceSats ?? 12627);
      return {
        id: "swap-1",
        invoice: f.invoice ? f.invoice(sats) : makeInvoice(sats, HASH),
        hashLock: f.hashLock ?? "0x" + HASH,
        sourceSats: String(sats),
        targetUnits: a.targetUnits,
        feeSats: "66",
        invoiceExpiresAt: T0 / 1000 + 600,
      };
    },
    async getSwap() {
      const s = f.statuses ?? ["serverfunded"];
      return { status: s[Math.min(calls.polls++, s.length - 1)]! };
    },
    async claim() {
      calls.claim++;
      if (f.claimFails) throw new Error("relay down");
      return {};
    },
  };
  return { client, calls };
}

function setup(f: FakeOpts = {}, network: "mainnet" | "testnet" = "mainnet") {
  let t = T0;
  let n = 0;
  const fc = fakeClient(f);
  const route = lendaswapExitRoute({ client: fc.client, network, now: () => t });
  const engine = new Engine({ routes: [route], store: new MemoryOrderStore(), network: "mainnet", now: () => t, newId: () => `id-${++n}` });
  return { engine, ...fc, advance: (ms: number) => (t += ms) };
}

const intent = (amount = "10"): PayIntent => {
  const p = parsePaymentInput(ADDRESS);
  if (!p.ok) throw new Error();
  return { kind: "pay", destination: p.value, sourceAsset: "NIM", targetChain: "polygon", amount: { amount, currency: "USDC" } };
};

const wallet = (): WalletExecutor & { steps: Step[] } => {
  const steps: Step[] = [];
  return { steps, async execute(s) { steps.push(s); return { ref: "tx:swap" }; } };
};

describe("NIM to USDC exit route", () => {
  it("quotes, pays the hold invoice, claims, and finishes with a receipt", async () => {
    const h = setup({ statuses: ["pending", "clientfunded", "serverfunded", "clientredeemed"] });
    const q = await h.engine.quote(intent());
    if (!q.ok) throw new Error(q.error.message);
    const quote = q.value[0]!;
    expect(quote.receive).toEqual({ amount: "10", currency: "USDC" });
    expect(quote.send).toEqual({ amount: "12627", currency: "SAT" });
    expect(h.calls.create[0]).toMatchObject({ chain: "polygon", targetAddress: ADDRESS, targetUnits: "10000000" });

    const c = await h.engine.createOrder(quote);
    if (!c.ok) throw new Error();
    const w = wallet();
    let o = await h.engine.approve(c.value.id, w);
    expect(o.state).toBe("processing");
    expect(w.steps[0]).toMatchObject({ kind: "pay-lightning-invoice" });

    expect((await h.engine.poll(o.id)).state).toBe("processing"); // pending
    expect((await h.engine.poll(o.id)).state).toBe("processing"); // clientfunded
    expect(h.calls.claim).toBe(0);
    expect((await h.engine.poll(o.id)).state).toBe("processing"); // serverfunded: claim now
    expect(h.calls.claim).toBe(1);
    o = await h.engine.poll(o.id); // clientredeemed
    expect(o.state).toBe("completed");
    expect(o.settlement).toBe("verified");
  });

  it("retries a failed claim on the next poll instead of giving up", async () => {
    const h = setup({ statuses: ["serverfunded"], claimFails: true });
    const q = await h.engine.quote(intent());
    if (!q.ok) throw new Error();
    const c = await h.engine.createOrder(q.value[0]!);
    if (!c.ok) throw new Error();
    await h.engine.approve(c.value.id, wallet());
    await h.engine.poll(c.value.id);
    await h.engine.poll(c.value.id);
    expect(h.calls.claim).toBe(2);
  });

  it("fails with a refund explanation when the swap expires", async () => {
    const h = setup({ statuses: ["expired"] });
    const q = await h.engine.quote(intent());
    if (!q.ok) throw new Error();
    const c = await h.engine.createOrder(q.value[0]!);
    if (!c.ok) throw new Error();
    await h.engine.approve(c.value.id, wallet());
    const o = await h.engine.poll(c.value.id);
    expect(o.state).toBe("failed");
    expect(o.message).toMatch(/returned automatically/);
    expect(o.message).toContain(c.value.id);
  });

  it("needs an amount, a network, and a USDC amount", async () => {
    const h = setup();
    const noChain = await h.engine.quote({ ...intent(), targetChain: undefined });
    expect(noChain.ok).toBe(false);
    const wrongCurrency = await h.engine.quote({ ...intent(), amount: { amount: "10", currency: "KES" } });
    expect(wrongCurrency.ok).toBe(false);
  });

  it("refuses sub-cent precision beyond USDC's 6 decimals", async () => {
    const r = await setup().engine.quote(intent("1.0000001"));
    expect(!r.ok && r.error.message).toMatch(/6 decimal/);
  });
});

describe("refusing a bad hold invoice before any money moves", () => {
  const err = async (f: FakeOpts, network?: "mainnet" | "testnet") => {
    const r = await setup(f, network).engine.quote(intent());
    return r.ok ? null : r.error.message;
  };
  it("rejects an invoice locked to someone else's hash", async () => {
    expect(await err({ invoice: (s) => makeInvoice(s, "cd".repeat(32)) })).toMatch(/doesn't match the quote/);
  });
  it("rejects an invoice for a different amount", async () => {
    expect(await err({ invoice: () => makeInvoice(99_999, HASH) })).toMatch(/doesn't match the quote/);
  });
  it("rejects the wrong network", async () => {
    expect(await err({ invoice: (s) => makeInvoice(s, HASH, `lntb${s * 10}n`) })).toMatch(/doesn't match the quote/);
  });
  it("turns provider outages into a retry message", async () => {
    expect(await err({ createFails: true })).toMatch(/couldn't price this/);
  });
});
