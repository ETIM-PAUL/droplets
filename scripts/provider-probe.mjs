// Phase 4 spike: unauthenticated reachability probe for each provider.
// Run with: node --env-file=.env scripts/provider-probe.mjs  (keys in .env enable the authenticated check).
const probes = [
  { provider: "Boltz", url: "https://api.boltz.exchange/v2/swap/submarine", note: "public pairs" },
  { provider: "Bitrefill", url: "https://api.bitrefill.com/v2/ping", note: "401 = reachable, key needed" },
  { provider: "Mavapay (staging)", url: "https://staging.api.mavapay.co/api/v1", note: "key needed" },
  { provider: "Mavapay (live)", url: "https://api.mavapay.co/api/v1", note: "key needed" },
  { provider: "LendaSwap", url: "https://swap.lendasat.com/", note: "web app; API docs not found" },
  { provider: "Machankura", url: "https://8333.mobi", note: "no public API docs found" },
];

for (const p of probes) {
  try {
    const res = await fetch(p.url, { signal: AbortSignal.timeout(10_000) });
    console.log(`${p.provider.padEnd(20)} ${res.status}  ${p.note}`);
  } catch (e) {
    console.log(`${p.provider.padEnd(20)} UNREACHABLE (${e.cause?.code ?? e.message})  ${p.note}`);
  }
}

if (process.env.BITREFILL_API_KEY) {
  const base = process.env.BITREFILL_BASE_URL ?? "https://api.bitrefill.com/v2";
  const res = await fetch(`${base}/ping`, {
    headers: { Authorization: `Bearer ${process.env.BITREFILL_API_KEY}` },
    signal: AbortSignal.timeout(10_000),
  });
  console.log(`${"Bitrefill (keyed)".padEnd(20)} ${res.status}  ${res.ok ? "key accepted" : "key rejected"}`);
}

if (process.env.MAVAPAY_API_KEY) {
  const res = await fetch(`${process.env.MAVAPAY_BASE_URL}/wallet`, {
    headers: { "x-api-key": process.env.MAVAPAY_API_KEY },
    signal: AbortSignal.timeout(10_000),
  });
  console.log(`${"Mavapay (keyed)".padEnd(20)} ${res.status}  ${res.ok ? "key accepted" : "key rejected"}`);
}
