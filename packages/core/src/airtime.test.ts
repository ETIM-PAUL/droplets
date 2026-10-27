import { describe, expect, it } from "vitest";
import { chooseAirtimeAmount, type AirtimeOperator } from "./airtime";

// Shape and numbers from Bitrefill's real Safaricom Kenya product (2026-10-27).
const SAFARICOM: AirtimeOperator = {
  id: "safaricom-kenya",
  name: "Safaricom Kenya",
  country: "KE",
  currency: "KES",
  packages: [
    { id: "safaricom-kenya<&>500", value: "500", priceSats: "4770" },
    { id: "safaricom-kenya<&>1000", value: "1000", priceSats: "9540" },
  ],
  range: { min: "280", max: "4573", step: "1" },
};

describe("chooseAirtimeAmount", () => {
  it("prefers an exact package", () => {
    expect(chooseAirtimeAmount(SAFARICOM, { amount: "500", currency: "KES" })).toEqual({ ok: true, value: { packageId: "safaricom-kenya<&>500", value: "500" } });
  });
  it("falls back to the range", () => {
    expect(chooseAirtimeAmount(SAFARICOM, { amount: "300", currency: "KES" })).toEqual({ ok: true, value: { packageId: null, value: "300" } });
  });
  it("explains the limits", () => {
    const r = chooseAirtimeAmount(SAFARICOM, { amount: "100", currency: "KES" });
    expect(!r.ok && r.error.message).toBe("Safaricom Kenya tops up between 280 and 4573 KES.");
  });
  it("respects steps and package-only operators", () => {
    const stepped = { ...SAFARICOM, range: { min: "10", max: "100", step: "10" } };
    expect(chooseAirtimeAmount(stepped, { amount: "15", currency: "KES" }).ok).toBe(false);
    const fixed = { ...SAFARICOM, range: null };
    const r = chooseAirtimeAmount(fixed, { amount: "700", currency: "KES" });
    expect(!r.ok && r.error.message).toMatch(/500, 1000 KES/);
  });
  it("refuses the wrong currency", () => {
    expect(chooseAirtimeAmount(SAFARICOM, { amount: "500", currency: "NGN" }).ok).toBe(false);
  });
});
