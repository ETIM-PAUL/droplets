import { describe, expect, it } from "vitest";
import { ApiError, createRailkitClient } from "./index";

const fakeFetch = (status: number, body: unknown, seen: string[] = []) =>
  (async (url: RequestInfo | URL) => {
    seen.push(String(url));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;

describe("RailKit client", () => {
  it("calls the API and returns typed data", async () => {
    const seen: string[] = [];
    const c = createRailkitClient({ baseUrl: "/api/", fetch: fakeFetch(200, { orderId: "o-1", state: "paid" }, seen) });
    expect(await c.payouts.getOrder("o 1")).toEqual({ orderId: "o-1", state: "paid" });
    expect(seen[0]).toBe("/api/v1/payouts/orders/o%201");
  });

  it("surfaces the server's user-facing error message", async () => {
    const c = createRailkitClient({ baseUrl: "/api", fetch: fakeFetch(403, { error: { message: "Kenya: M-Pesa is paused right now." } }) });
    await expect(c.corridors()).rejects.toMatchObject({ status: 403, message: "Kenya: M-Pesa is paused right now." });
  });

  it("turns network failures into a connection message", async () => {
    const c = createRailkitClient({ baseUrl: "/api", fetch: (async () => { throw new TypeError("offline"); }) as typeof fetch });
    await expect(c.corridors()).rejects.toBeInstanceOf(ApiError);
  });
});
