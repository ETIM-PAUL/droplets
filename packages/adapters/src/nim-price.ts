import { parsePrice, type PriceSource } from "@railkit/core";

interface Source {
  name: string;
  url: string;
  read: (j: unknown) => unknown;
}

/** Public NIM prices, no keys needed. Checked on 2026-11-04: MEXC and Bitget don't list NIM. */
const SOURCES: Source[] = [
  { name: "coingecko", url: "https://api.coingecko.com/api/v3/simple/price?ids=nimiq-2&vs_currencies=usd&precision=full", read: (j) => (j as Record<string, { usd?: unknown }>)["nimiq-2"]?.usd },
  { name: "kucoin", url: "https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=NIM-USDT", read: (j) => (j as { data?: { price?: unknown } }).data?.price },
  { name: "gate", url: "https://api.gateio.ws/api/v4/spot/tickers?currency_pair=NIM_USDT", read: (j) => (j as { last?: unknown }[])[0]?.last },
];

/**
 * Fetches NIM's price from each source in parallel. A source that fails or answers nonsense is left out;
 * `choosePrice` decides whether what's left is enough to settle. Exchange prices are in USDT, read as dollars.
 */
export function nimPriceSources(o: { fetch?: typeof fetch; timeoutMs?: number } = {}): () => Promise<PriceSource[]> {
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  return async () => {
    const answers = await Promise.allSettled(
      SOURCES.map(async (s) => {
        const res = await doFetch(s.url, { signal: AbortSignal.timeout(o.timeoutMs ?? 8_000) });
        if (!res.ok) throw new Error(`${s.name} answered ${res.status}`);
        const v = s.read(await res.json());
        const text = typeof v === "number" ? v.toFixed(12) : String(v);
        return { name: s.name, price: parsePrice(text) };
      }),
    );
    return answers.flatMap((a) => (a.status === "fulfilled" && a.value.price > 0n ? [a.value] : []));
  };
}
