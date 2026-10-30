import { createHmac } from "node:crypto";
import { ProviderError, type PayoutQuote } from "@railkit/adapters";
import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "./app";

const QUOTE: PayoutQuote = {
  quoteId: "q1", orderId: "261026-AAAAA-BBBBB", invoice: "lnbc...", sats: "25000", feeSats: "700",
  receive: { amount: "2500", currency: "KES" }, expiresAt: 1_800_000_000_000,
};

function setup(over: Partial<AppDeps> = {}) {
  const calls: unknown[] = [];
  const logs: string[] = [];
  const app = createApp({
    mavapay: {
      quote: async (r) => (calls.push(r), QUOTE),
      getOrder: async (id) => ({ orderId: id, state: "paid" }),
      banks: async () => [{ name: "GTBANK PLC", code: "000013" }],
      nameEnquiry: async () => ({ accountName: "Jane Jackson" }),
    },
    corridors: new Set(["ke-mpesa", "ng-bank"]),
    allowedOrigins: ["https://errand.example"],
    webhookSecret: "whsec",
    log: (m) => logs.push(m),
    ...over,
  });
  return { app, calls, logs };
}

const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const KE = {
  corridor: "ke-mpesa",
  amount: { amount: "2500", currency: "KES" },
  recipient: { type: "mobile-money", phone: "0712 345 678", name: "Jane Doe", network: "mpesa" },
};

describe("payout API", () => {
  it("quotes a valid request with a normalised recipient", async () => {
    const { app, calls } = setup();
    const res = await app.request("/v1/payouts/quote", post(KE));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ orderId: QUOTE.orderId });
    expect(calls[0]).toMatchObject({ recipient: { phone: "+254712345678" } });
  });

  it("enforces the corridor kill switch", async () => {
    const { app, calls } = setup({ corridors: new Set(["ng-bank"]) });
    const res = await app.request("/v1/payouts/quote", post(KE));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/paused/);
    expect(calls).toHaveLength(0);
  });

  it("lists only enabled corridors", async () => {
    const res = await setup().app.request("/v1/corridors");
    const ids = ((await res.json()) as { corridors: { id: string }[] }).corridors.map((c) => c.id);
    expect(ids.sort()).toEqual(["ke-mpesa", "ng-bank"]);
  });

  it("rejects bad input before calling the provider", async () => {
    const { app, calls } = setup();
    for (const body of [
      "not json",
      { ...KE, corridor: "xx" },
      { ...KE, amount: { amount: "100", currency: "KES" } },
      { ...KE, recipient: { ...KE.recipient, phone: "123" } },
      { ...KE, recipient: null },
    ]) {
      expect((await app.request("/v1/payouts/quote", post(body))).status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("passes provider errors through with their status, and hides unexpected ones", async () => {
    const providerFail = setup({
      mavapay: { quote: async () => { throw new ProviderError("Amount cannot be less than 150 KES", 400); }, getOrder: async () => { throw new Error("boom"); }, banks: async () => [], nameEnquiry: async () => ({ accountName: "" }) },
    });
    const r1 = await providerFail.app.request("/v1/payouts/quote", post(KE));
    expect(r1.status).toBe(400);
    expect(await r1.json()).toEqual({ error: { message: "Amount cannot be less than 150 KES" } });
    const r2 = await providerFail.app.request("/v1/payouts/orders/261026-AAAAA-BBBBB");
    expect(r2.status).toBe(502);
    expect(JSON.stringify(await r2.json())).not.toMatch(/boom/);
  });

  it("validates order ids", async () => {
    const { app } = setup();
    expect((await app.request("/v1/payouts/orders/261026-AAAAA-BBBBB")).status).toBe(200);
    expect((await app.request("/v1/payouts/orders/..%2F..%2Fetc")).status).toBe(400);
  });

  it("rate-limits quotes per client", async () => {
    const { app } = setup();
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await app.request("/v1/payouts/quote", post(KE, { "x-forwarded-for": "1.2.3.4" }))).status;
    expect(last).toBe(429);
    // A spoofed first entry doesn't buy a fresh allowance.
    expect((await app.request("/v1/payouts/quote", post(KE, { "x-forwarded-for": "9.9.9.9, 1.2.3.4" }))).status).toBe(429);
    expect((await app.request("/v1/payouts/quote", post(KE, { "x-forwarded-for": "5.6.7.8" }))).status).toBe(200);
  });

  it("sends CORS headers only for allowed origins", async () => {
    const { app } = setup();
    const ok = await app.request("/v1/corridors", { headers: { Origin: "https://errand.example" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://errand.example");
    const no = await app.request("/v1/corridors", { headers: { Origin: "https://evil.example" } });
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("checks Nigerian account names", async () => {
    const { app } = setup();
    expect(await (await app.request("/v1/payouts/name-enquiry?accountNumber=0087241555&bankCode=000013")).json()).toEqual({ accountName: "Jane Jackson" });
    expect((await app.request("/v1/payouts/name-enquiry?accountNumber=1&bankCode=000013")).status).toBe(400);
  });
});

describe("Mavapay webhook", () => {
  const event = JSON.stringify({ event: "payment.sent", data: { id: "tx_1", status: "SUCCESS", metadata: { orderId: "o1" } } });
  const sig = (body: string, secret = "whsec") => createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a correctly signed event", async () => {
    const { app, logs } = setup();
    const res = await app.request("/v1/webhooks/mavapay", post(event, { "x-mavapay-signature": sig(event) }));
    expect(res.status).toBe(200);
    expect(logs).toContain("mavapay webhook");
  });

  it("accepts the docs' JSON.stringify(parsed) signing as well", async () => {
    const spaced = JSON.stringify(JSON.parse(event), null, 2);
    const res = await setup().app.request("/v1/webhooks/mavapay", post(spaced, { "x-mavapay-signature": sig(event) }));
    expect(res.status).toBe(200);
  });

  it("rejects bad or missing signatures", async () => {
    const { app } = setup();
    expect((await app.request("/v1/webhooks/mavapay", post(event, { "x-mavapay-signature": sig(event, "wrong") }))).status).toBe(403);
    expect((await app.request("/v1/webhooks/mavapay", post(event))).status).toBe(403);
    expect((await setup({ webhookSecret: undefined }).app.request("/v1/webhooks/mavapay", post(event))).status).toBe(503);
  });
});

describe("airtime API", () => {
  const OP = { id: "safaricom-kenya", name: "Safaricom Kenya", country: "KE", currency: "KES", packages: [], range: { min: "280", max: "4573", step: "1" } };
  function airtime(over: Partial<AppDeps> = {}) {
    const stale: string[] = [];
    const quotes: unknown[] = [];
    const { app } = setup({
      bitrefill: {
        lookup: async () => OP,
        quote: async (r) => (quotes.push(r), { invoiceId: "e1e1a0f4-4a06-4b15-ac5a-1899131ce602", invoice: "lnbc...", sats: "4886", receive: r.amount }),
        status: async (invoiceId) => ({ invoiceId, state: "paid" }),
        markStale: (id) => void stale.push(id),
      },
      airtimeCountries: new Set(["KE"]),
      bitrefillWebhookToken: "tok_abcdef123456",
      ...over,
    });
    return { app, stale, quotes };
  }

  it("looks up an operator for a normalised number", async () => {
    const res = await airtime().app.request("/v1/airtime/lookup?country=KE&phone=0712%20345%20678");
    expect(await res.json()).toEqual({ phone: "+254712345678", operator: OP });
  });

  it("quotes with a normalised phone", async () => {
    const h = airtime();
    const res = await h.app.request("/v1/airtime/quote", post({ country: "KE", phone: "0712345678", operatorId: "safaricom-kenya", amount: { amount: "500", currency: "KES" } }));
    expect(res.status).toBe(200);
    expect(h.quotes[0]).toMatchObject({ phone: "+254712345678" });
  });

  it("enforces the country kill switch and a configured provider", async () => {
    expect((await airtime().app.request("/v1/airtime/lookup?country=NG&phone=08031234567")).status).toBe(403);
    expect((await airtime({ bitrefill: undefined }).app.request("/v1/airtime/lookup?country=KE&phone=0712345678")).status).toBe(503);
  });

  it("validates invoice ids", async () => {
    const h = airtime();
    expect((await h.app.request("/v1/airtime/invoices/e1e1a0f4-4a06-4b15-ac5a-1899131ce602")).status).toBe(200);
    expect((await h.app.request("/v1/airtime/invoices/not-an-id")).status).toBe(400);
  });

  it("only lets webhooks with the secret token trigger a re-check", async () => {
    const h = airtime();
    const body = { id: "e1e1a0f4-4a06-4b15-ac5a-1899131ce602", status: "all_delivered" };
    expect((await h.app.request("/v1/webhooks/bitrefill/wrong_token_0000", post(body))).status).toBe(404);
    expect(h.stale).toEqual([]);
    expect((await h.app.request("/v1/webhooks/bitrefill/tok_abcdef123456", post(body))).status).toBe(200);
    expect(h.stale).toEqual([body.id]);
  });
});

import { issueSession, parseInvites } from "./ops/beta";
import { MemoryOpsStore } from "./ops/store";

describe("closed beta", () => {
  const T = 1_800_000_000_000;
  const beta = { invites: parseInvites("PAUL-7Q2=Paul,MAMA-K3=Mum"), secret: "s", maxSatsPerOrder: 30_000n, maxSatsPerDay: 60_000n };
  function betaApp() {
    const ops = new MemoryOpsStore();
    const alerts: string[] = [];
    // A minute before the fake quote expires, so open quotes count toward the cap.
    const { app } = setup({ ops, beta, now: () => T - 60_000, adminToken: "admin-token-123", alert: async (t) => void alerts.push(t) });
    const auth = (invite: string) => ({ Authorization: `Bearer ${issueSession(invite, beta, T)}` });
    return { app, ops, alerts, auth };
  }

  it("exchanges an invite code for a session", async () => {
    const { app } = betaApp();
    const ok = await app.request("/v1/session", post({ invite: " paul-7q2 " }));
    expect(await ok.json()).toMatchObject({ token: expect.any(String), name: "Paul" });
    expect((await app.request("/v1/session", post({ invite: "NOPE" }))).status).toBe(401);
  });

  it("requires a session for paid features, but not for listing corridors", async () => {
    const { app, auth } = betaApp();
    expect((await app.request("/v1/payouts/quote", post(KE))).status).toBe(401);
    expect((await app.request("/v1/corridors")).status).toBe(200);
    expect((await app.request("/v1/payouts/quote", post(KE, auth("PAUL-7Q2")))).status).toBe(200);
  });

  it("logs quotes under the invite and enforces the daily cap", async () => {
    const { app, ops, auth } = betaApp();
    // Each fake quote costs 25,000 sats; the cap is 60,000 a day.
    expect((await app.request("/v1/payouts/quote", post(KE, auth("PAUL-7Q2")))).status).toBe(200);
    expect((await ops.get(QUOTE.orderId))?.invite).toBe("PAUL-7Q2");
    await ops.recordQuote({ ...(await ops.get(QUOTE.orderId))!, id: "other-order-1" });
    const third = await app.request("/v1/payouts/quote", post(KE, auth("PAUL-7Q2")));
    expect(third.status).toBe(403);
    expect(((await third.json()) as { error: { message: string } }).error.message).toMatch(/24 hours/);
  });

  it("hides one tester's orders from another", async () => {
    const { app, auth } = betaApp();
    await app.request("/v1/payouts/quote", post(KE, auth("PAUL-7Q2")));
    expect((await app.request(`/v1/payouts/orders/${QUOTE.orderId}`, { headers: auth("PAUL-7Q2") })).status).toBe(200);
    expect((await app.request(`/v1/payouts/orders/${QUOTE.orderId}`, { headers: auth("MAMA-K3") })).status).toBe(404);
  });

  it("records order state from status checks", async () => {
    const { app, ops, auth } = betaApp();
    await app.request("/v1/payouts/quote", post(KE, auth("PAUL-7Q2")));
    await app.request(`/v1/payouts/orders/${QUOTE.orderId}`, { headers: auth("PAUL-7Q2") });
    expect((await ops.get(QUOTE.orderId))?.state).toBe("paid");
  });

  it("takes feedback and alerts the team", async () => {
    const { app, alerts, auth } = betaApp();
    const r = await app.request("/v1/feedback", post({ message: "Took ages", orderId: QUOTE.orderId }, auth("MAMA-K3")));
    expect(r.status).toBe(200);
    expect(alerts[0]).toBe(`FEEDBACK from MAMA-K3 on ${QUOTE.orderId}: "Took ages"`);
  });

  it("serves metrics only with the admin token", async () => {
    const { app } = betaApp();
    expect((await app.request("/v1/admin/metrics")).status).toBe(404);
    expect((await app.request("/v1/admin/metrics", { headers: { Authorization: "Bearer wrong" } })).status).toBe(404);
    const m = await app.request("/v1/admin/metrics", { headers: { Authorization: "Bearer admin-token-123" } });
    expect(await m.json()).toMatchObject({ completedOrders: 0, method: expect.stringMatching(/invite/) });
  });
});

describe("practice mode", () => {
  it("is absent unless configured", async () => {
    expect((await setup().app.request("/v1/dev/simulate-payment/261026-AAAAA-BBBBB", post({}))).status).toBe(404);
  });
  it("simulates a staging payment for an order", async () => {
    const seen: string[] = [];
    const { app } = setup({ simulatePayIn: async (id) => void seen.push(id) });
    const r = await app.request("/v1/dev/simulate-payment/261026-AAAAA-BBBBB", post({}));
    expect(r.status).toBe(200);
    expect(seen).toEqual(["261026-AAAAA-BBBBB"]);
    expect((await app.request("/v1/dev/simulate-payment/..%2Fx", post({}))).status).toBe(400);
  });
  it("refuses to simulate payment of an expired price", async () => {
    const ops = new MemoryOpsStore();
    await ops.recordQuote({ id: "261026-AAAAA-BBBBB", kind: "payout", invite: null, product: "ng-bank", receiveAmount: "2000", receiveCurrency: "NGN", sats: "2000", createdAt: 0, expiresAt: 1_000 });
    const seen: string[] = [];
    const { app } = setup({ ops, now: () => 2_000, simulatePayIn: async (id) => void seen.push(id) });
    const r = await app.request("/v1/dev/simulate-payment/261026-AAAAA-BBBBB", post({}));
    expect(r.status).toBe(400);
    expect(seen).toEqual([]);
  });
});
