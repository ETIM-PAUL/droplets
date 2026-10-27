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

  it("sends the session token and reports an ended session", async () => {
    let auth: string | null = null;
    let signedOut = false;
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      auth = (init?.headers as Record<string, string>).Authorization ?? null;
      return new Response(JSON.stringify({ error: { message: "Your invite has ended" } }), { status: 401 });
    }) as typeof fetch;
    const c = createRailkitClient({ baseUrl: "/api", fetch: f, token: () => "tok", onUnauthorized: () => (signedOut = true) });
    await expect(c.payouts.getOrder("o1")).rejects.toMatchObject({ status: 401 });
    expect(auth).toBe("Bearer tok");
    expect(signedOut).toBe(true);
  });

  it("turns network failures into a connection message", async () => {
    const c = createRailkitClient({ baseUrl: "/api", fetch: (async () => { throw new TypeError("offline"); }) as typeof fetch });
    await expect(c.corridors()).rejects.toBeInstanceOf(ApiError);
  });
});
