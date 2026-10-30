import { bech32 } from "@scure/base";
import { buildReceipt, Engine, MemoryOrderStore, receiptText, parsePaymentInput, WalletError, type PayIntent, type Step, type WalletExecutor } from "@railkit/core";
import { BITREFILL_500_KES as BITREFILL_INVOICE } from "@railkit/core/src/fixtures";
import { describe, expect, it } from "vitest";
import { bolt11Route } from "./bolt11-route";
import { lnurlPayRoute } from "./lnurl-pay-route";

const T0 = 1_800_000_000_000;
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));
const enc = (s: string) => new TextEncoder().encode(s);

/** Builds a structurally valid BOLT11 invoice with a dummy signature (the parser doesn't check signatures; wallets do). */
function makeInvoice(o: { sats: number; paymentHash: Uint8Array; descriptionHash: Uint8Array; hrp?: string; timestamp?: number; expiry?: number }) {
  const ts = o.timestamp ?? T0 / 1000;
  const tsWords = Array.from({ length: 7 }, (_, i) => Math.floor(ts / 32 ** (6 - i)) % 32);
  const field = (type: number, words: number[]) => [type, Math.floor(words.length / 32), words.length % 32, ...words];
  const body = [
    ...field(1, bech32.toWords(o.paymentHash)),
    ...field(23, bech32.toWords(o.descriptionHash)),
    ...(o.expiry ? field(6, [Math.floor(o.expiry / 32), o.expiry % 32]) : []),
  ];
  const sig = new Array(104).fill(0);
  return bech32.encode(o.hrp ?? `lnbc${o.sats * 10}n`, [...tsWords, ...body, ...sig], false);
}

const METADATA = JSON.stringify([["text/plain", "Coffee fund"]]);
const PREIMAGE = new Uint8Array(32).fill(7);

interface Service {
  params?: Record<string, unknown>;
  invoice?: (sats: number, hash: Uint8Array) => Promise<string> | string;
  verify?: boolean;
  settled?: boolean;
  preimage?: Uint8Array;
  fail?: { reason: string };
}

function fakeFetch(s: Service = {}) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    // Real services vary: Machankura answers with lowercase "error" and HTTP 404.
    if (s.fail) return json({ status: "error", reason: s.fail.reason }, 404);
    if (url.startsWith("https://example.com/.well-known/lnurlp/")) {
      return json({ tag: "payRequest", callback: "https://example.com/cb", minSendable: 1_000, maxSendable: 1_000_000_000, metadata: METADATA, ...s.params });
    }
    if (url.startsWith("https://example.com/cb")) {
      const sats = Number(new URL(url).searchParams.get("amount")) / 1000;
      const hash = await sha256(PREIMAGE);
      const pr = s.invoice ? await s.invoice(sats, hash) : makeInvoice({ sats, paymentHash: hash, descriptionHash: await sha256(enc(METADATA)) });
      return json({ pr, ...(s.verify === false ? {} : { verify: "https://example.com/verify/abc" }) });
    }
    if (url.startsWith("https://example.com/verify/")) {
      return json({ status: "OK", settled: s.settled ?? true, preimage: hex(s.preimage ?? PREIMAGE) });
    }
    return json({}, 404);
  }) as typeof fetch;
  return { f, calls };
}

function setup(s: Service = {}) {
  let t = T0;
  let n = 0;
  const net = fakeFetch(s);
  const route = lnurlPayRoute({ network: "mainnet", fetch: net.f, now: () => t });
  const engine = new Engine({ routes: [route], store: new MemoryOrderStore(), network: "mainnet", now: () => t, newId: () => `id-${++n}` });
  return { engine, net, advance: (ms: number) => (t += ms) };
}

const wallet = (): WalletExecutor & { steps: Step[] } => {
  const steps: Step[] = [];
  return { steps, async execute(step) { steps.push(step); return { ref: "txhash:swap1" }; } };
};

function intent(input: string, sats?: string): PayIntent {
  const p = parsePaymentInput(input);
  if (!p.ok) throw new Error(p.error.message);
  return { kind: "pay", destination: p.value, sourceAsset: "NIM", ...(sats ? { amount: { amount: sats, currency: "SAT" } } : {}) };
}

describe("paying a Lightning Address end to end", () => {
  it("resolves, quotes, pays, tracks to a verified receipt", async () => {
    const h = setup();
    const q = await h.engine.quote(intent("paul@example.com", "2500"));
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    const quote = q.value[0]!;
    expect(quote.receive).toEqual({ amount: "2500", currency: "SAT" });
    expect(quote.steps[0]).toMatchObject({ kind: "pay-lightning-invoice" });
    expect(quote.notes?.[0]).toMatch(/Nimiq Pay shows the final cost/);
    expect(h.net.calls[1]).toContain("amount=2500000"); // msat

    const created = await h.engine.createOrder(quote);
    if (!created.ok) throw new Error();
    const w = wallet();
    let o = await h.engine.approve(created.value.id, w);
    expect(o.state).toBe("processing");
    expect(w.steps[0]).toMatchObject({ kind: "pay-lightning-invoice" });

    o = await h.engine.poll(o.id);
    expect(o.state).toBe("completed");
    expect(o.settlement).toBe("verified");

    const r = buildReceipt(o)!;
    expect(r).toMatchObject({ recipient: "paul@example.com", receive: { amount: "2500", currency: "SAT" }, settlement: "verified" });
    expect(receiptText(r)).toMatch(/delivered, confirmed by the provider/);
    expect(receiptText(r)).not.toMatch(/lnbc/);
  });

  it("keeps waiting until the service says the invoice is settled", async () => {
    const h = setup({ settled: false });
    const q = await h.engine.quote(intent("paul@example.com", "100"));
    if (!q.ok) throw new Error();
    const c = await h.engine.createOrder(q.value[0]!);
    if (!c.ok) throw new Error();
    await h.engine.approve(c.value.id, wallet());
    expect((await h.engine.poll(c.value.id)).state).toBe("processing");
  });

  it("completes as unverified when the service offers no verify URL, and the receipt says so", async () => {
    const h = setup({ verify: false });
    const q = await h.engine.quote(intent("paul@example.com", "100"));
    if (!q.ok) throw new Error();
    expect(q.value[0]!.notes?.join(" ")).toMatch(/can't confirm receipt/);
    const c = await h.engine.createOrder(q.value[0]!);
    if (!c.ok) throw new Error();
    await h.engine.approve(c.value.id, wallet());
    const o = await h.engine.poll(c.value.id);
    expect(o.state).toBe("completed");
    expect(o.settlement).toBe("unverified");
    expect(receiptText(buildReceipt(o)!)).toMatch(/sent/);
  });

  it("fails an order whose confirmation doesn't match the invoice", async () => {
    const h = setup({ preimage: new Uint8Array(32).fill(9) });
    const q = await h.engine.quote(intent("paul@example.com", "100"));
    if (!q.ok) throw new Error();
    const c = await h.engine.createOrder(q.value[0]!);
    if (!c.ok) throw new Error();
    await h.engine.approve(c.value.id, wallet());
    expect((await h.engine.poll(c.value.id)).state).toBe("failed");
  });
});

describe("refusing bad services, before any money moves", () => {
  const quoteError = async (s: Service, sats = "2500", input = "paul@example.com") => {
    const r = await setup(s).engine.quote(intent(input, sats));
    return r.ok ? null : r.error.message;
  };

  it("asks for an amount first", async () => {
    const r = await setup().engine.quote(intent("paul@example.com"));
    expect(!r.ok && r.error.message).toMatch(/how much/);
  });

  it("explains the recipient's limits", async () => {
    expect(await quoteError({ params: { minSendable: 10_000_000 } })).toMatch(/accepts between 10000 and/);
  });

  it("passes on the service's own refusal", async () => {
    expect(await quoteError({ fail: { reason: "Account closed" } })).toMatch(/Account closed/);
  });

  it("rejects an invoice for a different amount", async () => {
    const m = await quoteError({ invoice: async (_s, h) => makeInvoice({ sats: 1, paymentHash: h, descriptionHash: await sha256(enc(METADATA)) }) });
    expect(m).toMatch(/doesn't match/);
  });

  it("rejects an invoice that doesn't commit to the metadata", async () => {
    const m = await quoteError({ invoice: async (s, h) => makeInvoice({ sats: s, paymentHash: h, descriptionHash: await sha256(enc("something else")) }) });
    expect(m).toMatch(/doesn't match/);
  });

  it("rejects an invoice on the wrong network", async () => {
    const m = await quoteError({ invoice: async (s, h) => makeInvoice({ sats: s, hrp: `lntb${s * 10}n`, paymentHash: h, descriptionHash: await sha256(enc(METADATA)) }) });
    expect(m).toMatch(/doesn't match/);
  });

  it("rejects an already-expired invoice", async () => {
    const m = await quoteError({ invoice: async (s, h) => makeInvoice({ sats: s, paymentHash: h, descriptionHash: await sha256(enc(METADATA)), timestamp: T0 / 1000 - 7200 }) });
    expect(m).toMatch(/expired/);
  });

  it("refuses withdrawal links", async () => {
    expect(await quoteError({ params: { tag: "withdrawRequest" } })).toMatch(/withdrawal/);
  });

  it("refuses fractional sats", async () => {
    expect(await quoteError({}, "1.5")).toMatch(/whole sats/);
  });
});

describe("bolt11Route", () => {
  const invoice = parsePaymentInput(BITREFILL_INVOICE);
  if (!invoice.ok || invoice.value.kind !== "bolt11") throw new Error("fixture");
  const inv = invoice.value;
  const at = inv.timestamp * 1000 + 60_000;
  const intent: PayIntent = { kind: "pay", destination: inv, sourceAsset: "NIM" };

  it("quotes the invoice as it stands and pays it in one step", async () => {
    const q = await bolt11Route({ network: "mainnet", now: () => at }).quote(intent);
    expect(q.send).toEqual({ amount: "4834", currency: "SAT" });
    expect(q.steps).toEqual([{ kind: "pay-lightning-invoice", invoice: inv.raw }]);
    expect(q.expiresAt).toBeLessThanOrEqual(inv.expiresAt * 1000 - 30_000);
  });

  it("refuses the wrong network and expired invoices, saying what to do", async () => {
    await expect(bolt11Route({ network: "testnet", now: () => at }).quote(intent)).rejects.toThrow(/Ask for a testnet invoice/);
    await expect(bolt11Route({ network: "mainnet", now: () => inv.expiresAt * 1000 + 1 }).quote(intent)).rejects.toThrow(/expired/);
  });

  it("counts as sent only when Nimiq Pay said it succeeded", async () => {
    const r = bolt11Route({ network: "mainnet" });
    expect(await r.poll("bolt11:x", { walletSucceeded: true })).toEqual({ status: "completed", verified: false });
    expect(await r.poll("bolt11:x", { walletSucceeded: false })).toEqual({ status: "pending" });
  });

  it("leaves an unknown wallet outcome unknown through the engine", async () => {
    const store = new MemoryOrderStore();
    const engine = new Engine({ routes: [bolt11Route({ network: "mainnet", now: () => at })], store, network: "mainnet", now: () => at });
    const q = await engine.quote(intent);
    if (!q.ok) throw new Error(q.error.message);
    const o = await engine.createOrder(q.value[0]!);
    if (!o.ok) throw new Error(o.error.message);
    const wallet: WalletExecutor = { execute: async () => { throw new WalletError("unknown", "timed out"); } };
    expect((await engine.approve(o.value.id, wallet)).state).toBe("outcome_unknown");
    expect((await engine.poll(o.value.id)).state).toBe("outcome_unknown");
  });
});
