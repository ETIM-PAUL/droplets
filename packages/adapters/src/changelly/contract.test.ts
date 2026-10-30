// Live checks against Changelly's Fiat API (sandbox or production keys). Run: pnpm test:contract
// Answers the open questions: is NIM for sale, by which providers, can Nigerians pay by bank transfer, what limits.
import { describe, expect, it } from "vitest";
import { createChangellyFiatApi } from "./api";

const on = process.env.CHANGELLY_CONTRACT === "1" && !!process.env.CHANGELLY_FIAT_PUBLIC_KEY && !!process.env.CHANGELLY_FIAT_PRIVATE_KEY;

describe.skipIf(!on)("Changelly Fiat API (live)", () => {
  const api = on
    ? createChangellyFiatApi({
        publicKey: process.env.CHANGELLY_FIAT_PUBLIC_KEY!,
        privateKey: process.env.CHANGELLY_FIAT_PRIVATE_KEY!,
        baseUrl: process.env.CHANGELLY_FIAT_BASE_URL || undefined,
      })
    : null!;
  const ticker = process.env.CHANGELLY_NIM_TICKER || "NIM";

  it("sells NIM, and says which providers do", async () => {
    const list = await api.currencies("buy");
    const nim = list.filter((c) => /nimiq/i.test(c.name) || c.ticker.toUpperCase() === ticker);
    console.log("NIM on sale:", JSON.stringify(nim, null, 2));
    expect(nim.length).toBeGreaterThan(0);
  });

  it.each(["NG", "KE"])("returns offers or reasons for %s", async (country) => {
    const r = await api.offers({ currencyFrom: country === "NG" ? "NGN" : "KES", currencyTo: ticker, amountFrom: country === "NG" ? "20000" : "2000", country });
    console.log(country, JSON.stringify(r, null, 2));
    expect(r.offers.length + r.errors.length).toBeGreaterThan(0);
  });

  it("accepts a Nimiq address", async () => {
    expect(await api.validateAddress(ticker, "NQ07 0000 0000 0000 0000 0000 0000 0000 0000")).toBe(true);
  });
});
