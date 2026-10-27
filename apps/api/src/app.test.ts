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
