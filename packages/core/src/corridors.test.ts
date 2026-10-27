import { describe, expect, it } from "vitest";
import { machankuraAddress, maskRecipient, validatePayoutAmount, validateRecipient } from "./corridors";
import { normalizePhone } from "./phone";

describe("normalizePhone", () => {
  it("accepts the ways people type Kenyan numbers", () => {
    for (const s of ["+254712345678", "254712345678", "0712345678", "0712 345 678", "+254-712-345-678", "712345678"]) {
      expect(normalizePhone(s, "KE")).toEqual({ ok: true, value: "+254712345678" });
    }
  });
  it("handles other countries", () => {
    expect(normalizePhone("024 123 4567", "GH")).toEqual({ ok: true, value: "+233241234567" });
    expect(normalizePhone("0803 123 4567", "NG")).toEqual({ ok: true, value: "+2348031234567" });
    expect(normalizePhone("082 123 4567", "ZA")).toEqual({ ok: true, value: "+27821234567" });
  });
  it("rejects wrong country, length and characters", () => {
    expect(normalizePhone("+233241234567", "KE").ok).toBe(false);
    expect(normalizePhone("07123", "KE").ok).toBe(false);
    expect(normalizePhone("07l2345678", "KE").ok).toBe(false);
  });
});

describe("validateRecipient", () => {
  it("normalises an M-Pesa recipient", () => {
    const r = validateRecipient("ke-mpesa", { type: "mobile-money", phone: "0712 345 678", name: " Jane Doe ", network: "mpesa" });
    expect(r).toEqual({ ok: true, value: { type: "mobile-money", phone: "+254712345678", name: "Jane Doe", network: "mpesa" } });
  });
  it("enforces MTN Ghana prefixes", () => {
    expect(validateRecipient("gh-mtn", { type: "mobile-money", phone: "0241234567", name: "Kofi", network: "mtn" }).ok).toBe(true);
    const vodafone = validateRecipient("gh-mtn", { type: "mobile-money", phone: "0201234567", name: "Kofi", network: "mtn" });
    expect(!vodafone.ok && vodafone.error.message).toMatch(/isn't on MTN/);
  });
  it("needs a name", () => {
    expect(validateRecipient("ke-mpesa", { type: "mobile-money", phone: "0712345678", name: " ", network: "mpesa" }).ok).toBe(false);
  });
  it("checks Nigerian bank details", () => {
    const good = { type: "bank" as const, bankCode: "000013", bankName: "GTBANK PLC", accountNumber: "0087 241 555", accountName: "Jane Jackson" };
    expect(validateRecipient("ng-bank", good)).toMatchObject({ ok: true, value: { accountNumber: "0087241555" } });
    expect(validateRecipient("ng-bank", { ...good, accountNumber: "12345" }).ok).toBe(false);
    expect(validateRecipient("ng-bank", { ...good, bankCode: undefined }).ok).toBe(false);
  });
  it("refuses the wrong recipient type", () => {
    expect(validateRecipient("ng-bank", { type: "mobile-money", phone: "0803", name: "x", network: "mtn" }).ok).toBe(false);
  });
});

describe("validatePayoutAmount", () => {
  it("enforces currency, precision and the minimum", () => {
    expect(validatePayoutAmount("ke-mpesa", { amount: "2500", currency: "KES" }).ok).toBe(true);
    expect(validatePayoutAmount("ke-mpesa", { amount: "100", currency: "KES" })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/150 KES/) } });
    expect(validatePayoutAmount("ke-mpesa", { amount: "2500", currency: "NGN" }).ok).toBe(false);
    expect(validatePayoutAmount("ng-bank", { amount: "10.505", currency: "NGN" }).ok).toBe(false);
  });
});

describe("display helpers", () => {
  it("masks recipients", () => {
    expect(maskRecipient({ type: "mobile-money", phone: "+254712345678", name: "Jane", network: "mpesa" })).toBe("Jane (+254••••678)");
    expect(maskRecipient({ type: "bank", bankName: "GTBANK PLC", accountNumber: "0087241555", accountName: "Jane" })).toBe("Jane, GTBANK PLC ••••1555");
  });
  it("builds Machankura addresses", () => {
    expect(machankuraAddress("+254712345678")).toBe("254712345678@8333.mobi");
  });
});
