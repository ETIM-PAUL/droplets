// Live contract test against Mavapay STAGING (no real money). Skipped unless run with
// `pnpm test:contract`, which loads .env and sets MAVAPAY_CONTRACT=1.
import { describe, expect, it } from "vitest";
import { createMavapayApi } from "./api";

const live = process.env.MAVAPAY_CONTRACT === "1" && !!process.env.MAVAPAY_API_KEY;
const base = process.env.MAVAPAY_BASE_URL ?? "";

describe.skipIf(!live)("Mavapay staging contract", () => {
  it("is pointed at staging, never live", () => {
    expect(base).toContain("staging");
  });

  it("quotes NGN, simulates the Lightning payment, and sees the payout succeed", { timeout: 180_000 }, async () => {
    const m = createMavapayApi({ apiKey: process.env.MAVAPAY_API_KEY!, baseUrl: base });
    const q = await m.quote({
      corridor: "ng-bank",
      amount: { amount: "5000", currency: "NGN" },
      recipient: { type: "bank", bankCode: "000013", bankName: "GTBANK PLC", accountNumber: "0087241555", accountName: "Contract Test" },
    });
    expect((await m.getOrder(q.orderId)).state).toBe("awaiting_payment");

    const sim = await fetch(`${base}/simulation/pay-in`, {
      method: "POST",
      headers: { "x-api-key": process.env.MAVAPAY_API_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({ currency: "BTC", quoteId: q.quoteId }),
    });
    expect(sim.status).toBe(200);

    let state = "";
    for (let i = 0; i < 50 && state !== "paid_out"; i++) {
      await new Promise((r) => setTimeout(r, 3_000));
      state = (await m.getOrder(q.orderId)).state;
    }
    expect(state).toBe("paid_out");
  });

  it("still quotes KES pay-to-phone", { timeout: 30_000 }, async () => {
    const m = createMavapayApi({ apiKey: process.env.MAVAPAY_API_KEY!, baseUrl: base });
    const q = await m.quote({
      corridor: "ke-mpesa",
      amount: { amount: "200", currency: "KES" },
      recipient: { type: "mobile-money", phone: "+254712345678", name: "Contract Test", network: "mpesa" },
    });
    expect(q.receive).toEqual({ amount: "200", currency: "KES" });
  });
});
