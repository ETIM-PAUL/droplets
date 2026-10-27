// Test helper: serves recorded Mavapay staging responses (fixtures/*.json) in place of the network.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const fixture = (name: string): { status: number; body: Record<string, unknown> } =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", `${name}.json`), "utf8"));

export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Each call takes the next fixture name from `script` (the last repeats); "THROW" simulates a network failure. */
export function fakeMavapay(script: string[]) {
  const calls: Recorded[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const name = script[Math.min(calls.length, script.length - 1)]!;
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (name === "THROW") throw new TypeError("fetch failed");
    if (name === "GARBAGE") return new Response("<html>", { status: 502 });
    const fx = fixture(name);
    return new Response(JSON.stringify(fx.body), { status: fx.status });
  }) as typeof fetch;
  return { f, calls };
}
