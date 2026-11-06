import { parsePrice } from "@railkit/core";
import { describe, expect, it } from "vitest";
import { nimPriceSources } from "./nim-price";

// The three answers as they came back on 2026-11-04.
const ANSWERS: Record<string, unknown> = {
  "api.coingecko.com": { "nimiq-2": { usd: 0.0003016254871891327 } },
  "api.kucoin.com": { code: "200000", data: { price: "0.0002938", bestBid: "0.0002932" } },
  "api.gateio.ws": [{ currency_pair: "NIM_USDT", last: "0.000301" }],
};

describe("nimPriceSources", () => {
  it("reads all three sources", async () => {
    const prices = await nimPriceSources({ fetch: async (url) => Response.json(ANSWERS[new URL(String(url)).host]) })();
    expect(prices).toEqual([
      { name: "coingecko", price: parsePrice("0.000301625487") },
      { name: "kucoin", price: parsePrice("0.0002938") },
      { name: "gate", price: parsePrice("0.000301") },
    ]);
  });

  it("leaves out a source that fails or answers nonsense", async () => {
    const prices = await nimPriceSources({
      fetch: async (url) => {
        const host = new URL(String(url)).host;
        if (host === "api.kucoin.com") throw new TypeError("fetch failed");
        if (host === "api.gateio.ws") return Response.json([{ last: "not a number" }]);
        return Response.json(ANSWERS[host]);
      },
    })();
    expect(prices.map((p) => p.name)).toEqual(["coingecko"]);
  });
});
