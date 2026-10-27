import type { Order } from "@railkit/core";
import { describe, expect, it } from "vitest";
import { formatAmount, formatCountdown, formatMoney } from "./format";
import { LocalOrderStore, recipientBook } from "./storage";

class MemStorage {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
}
const order = (id: string, createdAt: number) => ({ id, createdAt, state: "processing" }) as unknown as Order;

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

describe("LocalOrderStore", () => {
  it("survives a reload", async () => {
    const s = new MemStorage() as unknown as Storage;
    await new LocalOrderStore(s).put(order("a", 1));
    expect((await new LocalOrderStore(s).get("a"))?.id).toBe("a");
  });
  it("keeps the newest orders only", async () => {
    const store = new LocalOrderStore(new MemStorage() as unknown as Storage, "k", 2);
    for (const [id, t] of [["a", 1], ["b", 2], ["c", 3]] as const) await store.put(order(id, t));
    expect((await store.list()).map((o) => o.id)).toEqual(["c", "b"]);
  });
  it("works when storage throws", async () => {
    const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } } as unknown as Storage;
    const store = new LocalOrderStore(broken);
    await store.put(order("a", 1));
    expect((await store.get("a"))?.id).toBe("a");
  });
});

describe("recipientBook", () => {
  it("moves a repeat recipient to the top without duplicating", () => {
    const book = recipientBook(new MemStorage() as unknown as Storage);
    const jane = { corridor: "ke-mpesa" as const, recipient: { type: "mobile-money" as const, phone: "+254712345678", name: "Jane", network: "mpesa" as const }, lastAmount: "2500", usedAt: 1 };
    const tom = { ...jane, recipient: { ...jane.recipient, phone: "+254722000000", name: "Tom" }, usedAt: 2 };
    book.remember(jane);
    book.remember(tom);
    book.remember({ ...jane, lastAmount: "3000", usedAt: 3 });
    expect(book.list().map((r) => [r.recipient.type === "mobile-money" && r.recipient.name, r.lastAmount])).toEqual([["Jane", "3000"], ["Tom", "2500"]]);
  });
});
