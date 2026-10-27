import { buildReceipt, Engine, MemoryOrderStore, parseBolt11, type PayIntent, type Step, type WalletExecutor } from "@railkit/core";
import { describe, expect, it } from "vitest";
import { createMavapayApi, orderState, ProviderError } from "./api";
import { fakeMavapay, fixture } from "./fake";
import { payoutRoute } from "./route";

const BASE = "https://staging.api.mavapay.co/api/v1";
const api = (script: string[], now?: () => number) => {
  const fake = fakeMavapay(script);
  return { api: createMavapayApi({ apiKey: "test-key", baseUrl: BASE, fetch: fake.f, now }), calls: fake.calls };
};
const invoiceTime = (name: string) => {
  const inv = parseBolt11((fixture(name).body.data as { invoice: string }).invoice);
  if (!inv.ok) throw new Error("fixture invoice unreadable");
  return inv.value.timestamp * 1000 + 5_000;
};

const JANE_KE = { type: "mobile-money" as const, phone: "+254712345678", name: "Jane Doe", network: "mpesa" as const };
const JANE_NG = { type: "bank" as const, bankCode: "000013", bankName: "GTBANK PLC", accountNumber: "0087241555", accountName: "Jane Jackson" };

describe("Mavapay API client (recorded staging responses)", () => {
  it("builds a KES pay-to-phone quote request and reads the reply", async () => {
    const { api: m, calls } = api(["quote-kes"]);
    const q = await m.quote({ corridor: "ke-mpesa", amount: { amount: "2500", currency: "KES" }, recipient: JANE_KE });
    expect(calls[0]).toMatchObject({ method: "POST", url: `${BASE}/quote`, headers: { "x-api-key": "test-key" } });
    expect(calls[0]!.body).toEqual({
      amount: "250000",
      sourceCurrency: "BTCSAT",
      targetCurrency: "KESCENT",
      paymentMethod: "LIGHTNING",
      paymentCurrency: "KESCENT",
      autopayout: true,
      beneficiary: { identifierType: "paytophone", identifiers: { phoneNumber: "+254712345678", accountName: "Jane Doe", network: "mpesa" } },
    });
    expect(q.receive).toEqual({ amount: "2500", currency: "KES" });
    expect(q.invoice.startsWith("lnbc")).toBe(true);
    expect(Number(q.sats)).toBeGreaterThan(Number(q.feeSats));
  });

  it("uses Mavapay's beneficiary format for Nigerian banks", async () => {
    const { api: m, calls } = api(["quote-ngn"]);
    await m.quote({ corridor: "ng-bank", amount: { amount: "5000", currency: "NGN" }, recipient: JANE_NG });
    expect((calls[0]!.body as { beneficiary: unknown }).beneficiary).toEqual({
      bankAccountName: "Jane Jackson", bankCode: "000013", bankName: "GTBANK PLC", bankAccountNumber: "0087241555",
    });
  });

  it("passes Mavapay's validation messages on, and hides server faults", async () => {
    await expect(api(["error-kes-min"]).api.quote({ corridor: "ke-mpesa", amount: { amount: "100", currency: "KES" }, recipient: JANE_KE }))
      .rejects.toMatchObject({ status: 400, message: "Amount cannot be less than 150 KES" });
    await expect(api(["error-order-missing"]).api.getOrder("000000-XXXXX-XXXXX")).rejects.toMatchObject({ status: 404 });
    await expect(api(["THROW"]).api.getOrder("x")).rejects.toBeInstanceOf(ProviderError);
    await expect(api(["GARBAGE"]).api.getOrder("x")).rejects.toMatchObject({ status: 502 });
  });

  it("refuses a quote whose amount doesn't match what we asked for", async () => {
    // The KES fixture is for 2,500 KES; asking for 3,000 must not silently accept it.
    await expect(api(["quote-kes"]).api.quote({ corridor: "ke-mpesa", amount: { amount: "3000", currency: "KES" }, recipient: JANE_KE }))
      .rejects.toMatchObject({ status: 502 });
  });

  it("maps real order states", () => {
    expect(orderState(fixture("order-kes-pending").body.data as never)).toBe("awaiting_payment");
    expect(orderState(fixture("order-zar-withdrawal-pending").body.data as never)).toBe("paid");
    expect(orderState(fixture("order-ngn-paid-out").body.data as never)).toBe("paid_out");
    expect(orderState({ status: "PAID", transactions: [{ type: "WITHDRAWAL", status: "FAILED" }] })).toBe("failed");
    expect(orderState({ status: "EXPIRED", transactions: [] })).toBe("expired");
  });

  it("lists banks and checks account names", async () => {
    expect((await api(["banks-ng"]).api.banks("NG"))[0]).toMatchObject({ name: expect.any(String), code: expect.any(String) });
    // Staging returns a made-up name per call, so compare with what was recorded.
    const recorded = (fixture("name-enquiry-ng").body.data as { accountName: string }).accountName;
    expect(await api(["name-enquiry-ng"]).api.nameEnquiry("0087241555", "000013")).toEqual({ accountName: recorded });
  });
});

describe("payout route through the engine", () => {
  const wallet = (): WalletExecutor & { steps: Step[] } => {
    const steps: Step[] = [];
    return { steps, async execute(s) { steps.push(s); return { ref: "tx:swap" }; } };
  };
  const intent = (corridor: "ng-bank" | "ke-mpesa", amount: string, currency: string, recipient: typeof JANE_NG | typeof JANE_KE): PayIntent => ({
    kind: "pay", destination: { kind: "fiat-payout", corridor, recipient }, sourceAsset: "NIM", amount: { amount, currency },
  });

  function setup(script: string[], enabled = ["ng-bank", "ke-mpesa"]) {
    let t = invoiceTime(script[0]!.startsWith("quote") ? script[0]! : "quote-ngn");
    let n = 0;
    const m = api(script, () => t);
    const route = payoutRoute({ gateway: m.api, network: "mainnet", enabled: new Set(enabled), now: () => t });
    const engine = new Engine({ routes: [route], store: new MemoryOrderStore(), network: "mainnet", now: () => t, newId: () => `id-${++n}` });
    return { engine, calls: m.calls, advance: (ms: number) => (t += ms) };
  }

  it("sends 5,000 NGN to a bank account end to end (recorded staging lifecycle)", async () => {
    const h = setup(["quote-ngn", "order-ngn-paid-out"]);
    const q = await h.engine.quote(intent("ng-bank", "5000", "NGN", JANE_NG));
    if (!q.ok) throw new Error(q.error.message);
    expect(q.value[0]!.receive).toEqual({ amount: "5000", currency: "NGN" });
    expect(q.value[0]!.send.currency).toBe("SAT");

    const c = await h.engine.createOrder(q.value[0]!);
    if (!c.ok) throw new Error();
    const w = wallet();
    let o = await h.engine.approve(c.value.id, w);
    expect(o.state).toBe("processing");
    expect(w.steps[0]).toMatchObject({ kind: "pay-lightning-invoice" });

    o = await h.engine.poll(o.id); // the recorded order: deposit and payout both SUCCESS
    expect(o.state).toBe("completed");
    expect(o.settlement).toBe("verified");
    expect(buildReceipt(o)!.recipient).toBe("Jane Jackson, GTBANK PLC ••••1555");
  });

  it("refuses a paused corridor without calling the provider", async () => {
    const h = setup(["quote-kes"], ["ng-bank"]);
    const q = await h.engine.quote(intent("ke-mpesa", "2500", "KES", JANE_KE));
    expect(!q.ok && q.error.message).toMatch(/paused/);
    expect(h.calls).toHaveLength(0);
  });

  it("validates the recipient and amount before calling the provider", async () => {
    const h = setup(["quote-kes"]);
    const bad = await h.engine.quote(intent("ke-mpesa", "2500", "KES", { ...JANE_KE, phone: "+233241234567" }));
    expect(!bad.ok && bad.error.message).toMatch(/isn't a KE number/);
    const small = await h.engine.quote(intent("ke-mpesa", "100", "KES", JANE_KE));
    expect(!small.ok && small.error.message).toMatch(/150 KES/);
    expect(h.calls).toHaveLength(0);
  });
});
