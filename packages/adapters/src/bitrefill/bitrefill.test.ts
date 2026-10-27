import { buildReceipt, Engine, MemoryOrderStore, parseBolt11, type PayIntent, type Step, type WalletExecutor } from "@railkit/core";
import { describe, expect, it } from "vitest";
import { fakeProvider, fixtureFrom } from "../fake-provider";
import { createBitrefillApi, invoiceState } from "./api";
import { airtimeRoute } from "./route";

const fixture = fixtureFrom("bitrefill");
const BASE = "https://api.bitrefill.com/v2";
const PHONE = "+254712345678";

function api(script: string[], now = () => 1_800_000_000_000, extra: Partial<Parameters<typeof createBitrefillApi>[0]> = {}) {
  const fake = fakeProvider("bitrefill", script);
  return { api: createBitrefillApi({ apiKey: "k", baseUrl: BASE, fetch: fake.f, now, ...extra }), calls: fake.calls };
}

describe("Bitrefill client (recorded live responses)", () => {
  it("looks up a Kenyan number's operator with packages and range", async () => {
    const { api: b, calls } = api(["check-phone-ke"]);
    const op = await b.lookup(PHONE);
    expect(calls[0]!.url).toBe(`${BASE}/check_phone_number?phone_number=%2B254712345678`);
    expect(calls[0]!.headers.Authorization).toBe("Bearer k");
    expect(op).toMatchObject({ id: "safaricom-kenya", currency: "KES", range: { min: "280", max: "4573", step: "1" } });
    expect(op.packages[0]).toMatchObject({ id: "safaricom-kenya<&>500", value: "500" });
  });

  it("caches lookups and stays inside Bitrefill's 10-per-minute account limit", async () => {
    const { api: b, calls } = api(["check-phone-ke"], () => 0, { lookupBudget: { calls: 2, perMs: 60_000 } });
    await b.lookup(PHONE);
    await b.lookup(PHONE);
    expect(calls).toHaveLength(1);
    await b.lookup("+254700000001");
    await expect(b.lookup("+254700000002")).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/Try again in a minute/) });
  });

  it("never accepts a Bitrefill test product as a phone's operator", async () => {
    const f = (async () =>
      new Response(JSON.stringify({ data: { id: "test-phone-refill-fail", name: "Test Phone Refill (Fail)", currency: "USD", recipient_type: "phone_number", packages: [] } }), { status: 200 })) as typeof fetch;
    const b = createBitrefillApi({ apiKey: "k", baseUrl: BASE, fetch: f });
    await expect(b.lookup(PHONE)).rejects.toMatchObject({ status: 404 });
  });

  it("turns Bitrefill's invalid-number 500 into a clear 400", async () => {
    await expect(api(["check-phone-bad"]).api.lookup("+1")).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/isn't valid/) });
  });

  it("creates an unpaid Lightning invoice for a package", async () => {
    const { api: b, calls } = api(["check-phone-ke", "invoice-safaricom-lightning-unpaid"]);
    const q = await b.quote({ phone: PHONE, operatorId: "safaricom-kenya", amount: { amount: "500", currency: "KES" } });
    expect(calls[1]!.body).toEqual({
      products: [{ product_id: "safaricom-kenya", package_id: "safaricom-kenya<&>500", quantity: 1, phone_number: PHONE }],
      payment_method: "lightning",
      auto_pay: false,
    });
    expect(q.invoice.startsWith("lnbc")).toBe(true);
    expect(q.receive).toEqual({ amount: "500", currency: "KES" });
  });

  it("refuses amounts outside the operator's limits, and a mismatched operator", async () => {
    await expect(api(["check-phone-ke"]).api.quote({ phone: PHONE, operatorId: "safaricom-kenya", amount: { amount: "100", currency: "KES" } }))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/between 280 and 4573/) });
    await expect(api(["check-phone-ke"]).api.quote({ phone: PHONE, operatorId: "airtel-kenya", amount: { amount: "500", currency: "KES" } }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("maps the statuses the live API really returns", () => {
    expect(invoiceState(fixture("invoice-safaricom-lightning-unpaid").body.data as never)).toBe("awaiting_payment");
    expect(invoiceState(fixture("invoice-test-ok-final").body.data as never)).toBe("delivered");
    expect(invoiceState(fixture("invoice-test-fail-final").body.data as never)).toBe("failed");
    expect(invoiceState({ status: "not_delivered", payment: { status: "paid" }, orders: [{ status: "created" }] })).toBe("paid");
  });

  it("caches status, re-checks after a webhook, and never exceeds the shared budget", async () => {
    let t = 0;
    const { api: b, calls } = api(["check-phone-ke", "invoice-safaricom-lightning-unpaid", "invoice-safaricom-lightning-unpaid"], () => t, { statusBudget: { calls: 1, perMs: 600_000 } });
    const q = await b.quote({ phone: PHONE, operatorId: "safaricom-kenya", amount: { amount: "500", currency: "KES" } });
    expect((await b.status(q.invoiceId)).state).toBe("awaiting_payment");
    expect(calls).toHaveLength(2); // served from cache
    b.markStale(q.invoiceId);
    await b.status(q.invoiceId);
    expect(calls).toHaveLength(3); // webhook forced one re-check
    b.markStale(q.invoiceId);
    t += 60_000;
    await b.status(q.invoiceId);
    expect(calls).toHaveLength(3); // budget spent: answer from cache
  });
});

describe("airtime route through the engine", () => {
  const unpaid = fixture("invoice-safaricom-lightning-unpaid").body.data as { payment: { address: string } };
  const inv = parseBolt11(unpaid.payment.address);
  if (!inv.ok) throw new Error("fixture invoice unreadable");
  const T = inv.value.timestamp * 1000 + 5_000;

  const intent = (amount = "500"): PayIntent => ({
    kind: "pay",
    destination: { kind: "airtime", phone: PHONE, operatorId: "safaricom-kenya", operatorName: "Safaricom Kenya" },
    sourceAsset: "NIM",
    amount: { amount, currency: "KES" },
  });
  const wallet = (): WalletExecutor & { steps: Step[] } => {
    const steps: Step[] = [];
    return { steps, async execute(s) { steps.push(s); return { ref: "tx:swap" }; } };
  };

  function setup(script: string[], countries = ["KE"]) {
    let n = 0;
    const b = api(script, () => T, { statusTtlMs: 0 });
    const engine = new Engine({
      routes: [airtimeRoute({ gateway: b.api, network: "mainnet", enabledCountries: new Set(countries), now: () => T })],
      store: new MemoryOrderStore(),
      network: "mainnet",
      now: () => T,
      newId: () => `id-${++n}`,
    });
    return { engine, calls: b.calls };
  }

  it("tops up 500 KES and tracks it to a delivered receipt", async () => {
    // Real quote from the recorded Safaricom invoice; status answers come from recorded invoices
    // (unpaid, then a delivered one from Bitrefill's free test product) run through the real mapping.
    const b = api(["check-phone-ke", "invoice-safaricom-lightning-unpaid"], () => T);
    const answers = ["invoice-safaricom-lightning-unpaid", "invoice-test-ok-final"].map((n) => invoiceState(fixture(n).body.data as never));
    let polls = 0;
    const gateway = { quote: b.api.quote, status: async (invoiceId: string) => ({ invoiceId, state: answers[Math.min(polls++, answers.length - 1)]! }) };
    const engine = new Engine({
      routes: [airtimeRoute({ gateway, network: "mainnet", enabledCountries: new Set(["KE"]), now: () => T })],
      store: new MemoryOrderStore(),
      network: "mainnet",
      now: () => T,
    });

    const q = await engine.quote(intent());
    if (!q.ok) throw new Error(q.error.message);
    expect(q.value[0]!.receive).toEqual({ amount: "500", currency: "KES" });
    expect(q.value[0]!.notes?.join(" ")).toMatch(/can't be reversed/);

    const c = await engine.createOrder(q.value[0]!);
    if (!c.ok) throw new Error();
    const w = wallet();
    let o = await engine.approve(c.value.id, w);
    expect(o.state).toBe("processing");
    expect(w.steps[0]).toMatchObject({ kind: "pay-lightning-invoice" });
    o = await engine.poll(o.id); // unpaid on Bitrefill's side
    expect(o.state).toBe("processing");
    o = await engine.poll(o.id); // delivered
    expect(o.state).toBe("completed");
    expect(buildReceipt(o)!.recipient).toBe("Safaricom Kenya top-up for +254••••678");
  });

  it("fails with a support refund message when the network rejects the top-up", async () => {
    const b = api(["check-phone-ke", "invoice-safaricom-lightning-unpaid"], () => T);
    const gateway = { quote: b.api.quote, status: async (invoiceId: string) => ({ invoiceId, state: invoiceState(fixture("invoice-test-fail-final").body.data as never) }) };
    const engine = new Engine({
      routes: [airtimeRoute({ gateway, network: "mainnet", enabledCountries: new Set(["KE"]), now: () => T })],
      store: new MemoryOrderStore(),
      network: "mainnet",
      now: () => T,
    });
    const q = await engine.quote(intent());
    if (!q.ok) throw new Error(q.error.message);
    const c = await engine.createOrder(q.value[0]!);
    if (!c.ok) throw new Error();
    await engine.approve(c.value.id, wallet());
    const o = await engine.poll(c.value.id);
    expect(o.state).toBe("failed");
    expect(o.message).toMatch(/support will refund/);
  });

  it("refuses a paused country before any request", async () => {
    const h = setup(["check-phone-ke"], ["NG"]);
    const q = await h.engine.quote(intent());
    expect(!q.ok && q.error.message).toMatch(/paused/);
    expect(h.calls).toHaveLength(0);
  });

  it("passes on the operator's limits", async () => {
    const h = setup(["check-phone-ke"]);
    const q = await h.engine.quote(intent("100"));
    expect(!q.ok && q.error.message).toMatch(/280 and 4573/);
  });

});
