import { describe, expect, it } from "vitest";
import { formatAmount, formatCountdown, formatMoney } from "./format";
import { sessionToken } from "./storage";

class MemStorage {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}

describe("format", () => {
  it("groups without floats", () => {
    expect(formatAmount("2500")).toBe("2,500.00");
    expect(formatAmount("1234567.5")).toBe("1,234,567.50");
    expect(formatMoney("2500", "KES")).toBe("2,500 KES");
    expect(formatMoney("12.5", "NGN")).toBe("12.50 NGN");
  });
  it("counts down", () => {
    expect(formatCountdown(245_000)).toBe("4:05");
    expect(formatCountdown(-1)).toBe("0:00");
  });
});

describe("sessionToken", () => {
  it("survives a reload and clears", () => {
    const s = new MemStorage() as unknown as Storage;
    sessionToken.set("tok", s);
    expect(sessionToken.get(s)).toBe("tok");
    sessionToken.clear(s);
    expect(sessionToken.get(s)).toBeNull();
  });
  it("works when storage throws", () => {
    const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } } as unknown as Storage;
    sessionToken.set("tok", broken);
    expect(sessionToken.get(broken)).toBeNull();
    expect(() => sessionToken.clear(broken)).not.toThrow();
  });
});
