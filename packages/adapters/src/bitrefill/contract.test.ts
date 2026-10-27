// Live contract test against Bitrefill using its FREE test products and unpaid invoices (no money moves).
// Skipped unless run with `pnpm test:contract`.
// Bitrefill remembers the last product bought per number, so free test orders use their own number
// and real lookups use another that has never seen a test product.
const LOOKUP_NUMBER = "+254722345671";
const TEST_ORDER_NUMBER = "+254700000009";
import { describe, expect, it } from "vitest";
import { createBitrefillApi, invoiceState } from "./api";

const live = process.env.MAVAPAY_CONTRACT === "1" && !!process.env.BITREFILL_API_KEY;
const base = process.env.BITREFILL_BASE_URL ?? "https://api.bitrefill.com/v2";
const headers = { Authorization: `Bearer ${process.env.BITREFILL_API_KEY}`, "Content-Type": "application/json" };

describe.skipIf(!live)("Bitrefill contract", () => {
  it("finds Safaricom for a Kenyan number and issues a Lightning invoice (left unpaid)", { timeout: 30_000 }, async () => {
    const b = createBitrefillApi({ apiKey: process.env.BITREFILL_API_KEY!, baseUrl: base });
    const op = await b.lookup(LOOKUP_NUMBER);
    expect(op.id).toBe("safaricom-kenya");
    const q = await b.quote({ phone: LOOKUP_NUMBER, operatorId: op.id, amount: { amount: op.range?.min ?? op.packages[0]!.value, currency: "KES" } });
    expect(q.invoice.startsWith("lnbc")).toBe(true);
    expect((await b.status(q.invoiceId)).state).toBe("awaiting_payment");
  });

  it("still reports a free test top-up as delivered", { timeout: 30_000 }, async () => {
    const created = await fetch(`${base}/invoices`, {
      method: "POST",
      headers,
      body: JSON.stringify({ products: [{ product_id: "test-phone-refill", package_id: "test-phone-refill<&>10", quantity: 1, phone_number: TEST_ORDER_NUMBER }], payment_method: "balance", auto_pay: true }),
    });
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    let state = "";
    for (let i = 0; i < 10 && state !== "delivered"; i++) {
      await new Promise((r) => setTimeout(r, 2_000));
      state = invoiceState(((await (await fetch(`${base}/invoices/${id}`, { headers })).json()) as { data: never }).data);
    }
    expect(state).toBe("delivered");
  });
});
