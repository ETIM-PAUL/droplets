import { serve } from "@hono/node-server";
import { createBitrefillApi, createMavapayApi, ProviderError } from "@railkit/adapters";
import { createNimiqRpc, nimStringToLuna, parseNimiqAddress } from "@railkit/core";
import { createChangellyFiatApi } from "@railkit/adapters/server";
import pg from "pg";
import { openAiExtractor, openAiQrExtractor, openAiSavingsClassifier, openAiSavingsPhraser } from "@railkit/agent";
import { createApp } from "./app";
import { parseInvites, type BetaConfig } from "./ops/beta";
import { airtimeToOps, payoutToOps, rampToOps } from "./ops/map";
import { MemoryOpsStore, PgOpsStore, type OpsStore } from "./ops/store";
import { checkStakes, runDraw, type PrizeDeps } from "./prize/routes";
import { MemoryPrizeStore, PgPrizeStore, type PrizeStore } from "./prize/store";
import type { SaveDeps } from "./save/routes";
import { MemorySaveStore, PgSaveStore, type SaveStore } from "./save/store";
import { watchOnce, webhookAlerter } from "./ops/watcher";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const publicUrl = process.env.PUBLIC_API_URL?.replace(/\/$/, "");
const bitrefillToken = process.env.BITREFILL_WEBHOOK_TOKEN || undefined;
const bitrefill = process.env.BITREFILL_API_KEY
  ? createBitrefillApi({
      apiKey: process.env.BITREFILL_API_KEY,
      baseUrl: process.env.BITREFILL_BASE_URL ?? "https://api.bitrefill.com/v2",
      webhookUrl: publicUrl && bitrefillToken ? `${publicUrl}/v1/webhooks/bitrefill/${bitrefillToken}` : undefined,
    })
  : undefined;

// Add money: Changelly's Fiat API. Off until its keys are set.
const ramp = process.env.CHANGELLY_FIAT_PUBLIC_KEY && process.env.CHANGELLY_FIAT_PRIVATE_KEY
  ? createChangellyFiatApi({
      publicKey: process.env.CHANGELLY_FIAT_PUBLIC_KEY,
      privateKey: process.env.CHANGELLY_FIAT_PRIVATE_KEY,
      callbackPublicKey: process.env.CHANGELLY_CALLBACK_PUBLIC_KEY || undefined,
      baseUrl: process.env.CHANGELLY_FIAT_BASE_URL || undefined,
    })
  : undefined;

// Send to M-Pesa and Nigerian banks: Mavapay. Off until its key is set, and then no corridor is served.
const mavapay = process.env.MAVAPAY_API_KEY ? createMavapayApi({ apiKey: process.env.MAVAPAY_API_KEY, baseUrl: required("MAVAPAY_BASE_URL") }) : undefined;
const corridors = mavapay ? list(process.env.CORRIDORS) : [];

const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 }) : null;

let ops: OpsStore;
if (pool) {
  const store = new PgOpsStore(pool);
  await store.migrate();
  ops = store;
} else {
  console.warn(JSON.stringify({ msg: "DATABASE_URL not set: order log is in memory and lost on restart" }));
  ops = new MemoryOpsStore();
}

// Errand Save (save codes and Grow). Off unless SAVE_ENABLED=true; the Mini App needs it on.
async function saveDeps(): Promise<SaveDeps | undefined> {
  if (process.env.SAVE_ENABLED !== "true") return undefined;
  const network = process.env.SAVE_NETWORK === "testnet" ? "testnet" : "mainnet";
  let store: SaveStore;
  if (pool) {
    const pgStore = new PgSaveStore(pool);
    await pgStore.migrate();
    store = pgStore;
  } else {
    console.warn(JSON.stringify({ msg: "DATABASE_URL not set: save codes are in memory and lost on restart" }));
    store = new MemorySaveStore();
  }
  // "NQ.. = Name, NQ.. = Name": validators shown first when someone opens Grow.
  const recommended = list(process.env.SAVE_VALIDATORS).flatMap((entry) => {
    const [address = "", name = ""] = entry.split("=").map((x) => x.trim());
    const a = parseNimiqAddress(address);
    return a.ok && name ? [{ address: a.value, name }] : [];
  });
  return { store, chain: createNimiqRpc({ url: rpcUrl(network) }), network, recommended };
}
const rpcUrl = (network: "mainnet" | "testnet") =>
  process.env.NIMIQ_RPC_URL || (network === "testnet" ? "https://rpc.testnet.nimiqwatch.com" : "https://rpc.nimiqwatch.com");
const save = await saveDeps();

// The weekly draw for people who keep savings in Grow. Off unless PRIZE_ENABLED=true; needs savings on.
async function prizeDeps(): Promise<PrizeDeps | undefined> {
  if (process.env.PRIZE_ENABLED !== "true" || !save) return undefined;
  const nim = (name: string, fallback: string) => {
    const v = nimStringToLuna(process.env[name] || fallback);
    if (!v.ok) throw new Error(`${name}: ${v.error.message}`);
    return v.value;
  };
  const whole = (name: string, fallback: number, ok: (n: number) => boolean) => {
    const n = Number(process.env[name] || fallback);
    if (!Number.isInteger(n) || !ok(n)) throw new Error(`${name} is out of range.`);
    return n;
  };
  const address = process.env.PRIZE_ADDRESS ? parseNimiqAddress(process.env.PRIZE_ADDRESS) : null;
  if (address && !address.ok) throw new Error(`PRIZE_ADDRESS: ${address.error.message}`);
  let store: PrizeStore;
  if (pool) {
    const pgStore = new PgPrizeStore(pool);
    await pgStore.migrate();
    store = pgStore;
  } else {
    console.warn(JSON.stringify({ msg: "DATABASE_URL not set: draw entries are in memory and lost on restart" }));
    store = new MemoryPrizeStore();
  }
  return {
    store,
    chain: createNimiqRpc({ url: rpcUrl(save.network) }),
    rules: {
      minLuna: nim("PRIZE_MIN_NIM", "1000"),
      daysNeeded: whole("PRIZE_DAYS", 5, (n) => n >= 1 && n <= 7),
      prizeLuna: nim("PRIZE_NIM", "1000"),
      utcOffsetMinutes: whole("PRIZE_UTC_OFFSET_MINUTES", 60, (n) => Math.abs(n) <= 14 * 60),
    },
    prizeAddress: address?.ok ? address.value : null,
  };
}
const prize = await prizeDeps();

const beta: BetaConfig | undefined =
  process.env.BETA_REQUIRED === "true"
    ? {
        invites: parseInvites(process.env.BETA_INVITES),
        secret: required("SESSION_SECRET"),
        maxSatsPerOrder: BigInt(process.env.BETA_MAX_SATS_PER_ORDER ?? "150000"),
        maxSatsPerDay: BigInt(process.env.BETA_MAX_SATS_PER_DAY ?? "300000"),
      }
    : undefined;

const alert = webhookAlerter(process.env.ALERT_WEBHOOK_URL || undefined);

// Practice mode only ever talks to Mavapay staging: refuse to start it against live keys.
const practice = process.env.PRACTICE_MODE === "true";
if (practice && !/staging/.test(process.env.MAVAPAY_BASE_URL ?? "")) {
  throw new Error("PRACTICE_MODE=true needs MAVAPAY_BASE_URL to point at Mavapay staging");
}

const app = createApp({
  save,
  prize,
  simulatePayIn: practice
    ? async (orderId) => {
        const res = await fetch(`${process.env.MAVAPAY_BASE_URL}/simulation/pay-in`, {
          method: "POST",
          headers: { "x-api-key": required("MAVAPAY_API_KEY"), "Content-Type": "application/json" },
          body: JSON.stringify({ currency: "BTC", orderId }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as { message?: string } | null;
          throw new ProviderError(`Practice payment failed: ${j?.message ?? res.status}`, 502);
        }
      }
    : undefined,
  ops,
  beta,
  alert,
  adminToken: process.env.ADMIN_TOKEN || undefined,
  bitrefill,
  airtimeCountries: new Set(list(process.env.AIRTIME_COUNTRIES)),
  bitrefillWebhookToken: bitrefillToken,
  mavapay,
  corridors: new Set(corridors),
  allowedOrigins: list(process.env.ALLOWED_ORIGINS),
  webhookSecret: process.env.MAVAPAY_WEBHOOK_SECRET || undefined,
  ramp: ramp ? { api: ramp, countries: new Set(list(process.env.TOPUP_COUNTRIES)), nimTicker: process.env.CHANGELLY_NIM_TICKER || "NIM" } : undefined,
  agent: {
    model: process.env.OPENAI_API_KEY ? openAiExtractor({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || undefined }) : undefined,
    qrModel: process.env.OPENAI_API_KEY ? openAiQrExtractor({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || undefined }) : undefined,
    savingsPhraser: process.env.OPENAI_API_KEY ? openAiSavingsPhraser({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || undefined }) : undefined,
    savingsClassifier: process.env.OPENAI_API_KEY ? openAiSavingsClassifier({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || undefined }) : undefined,
    modelCallsPerDay: Number(process.env.AGENT_MODEL_CALLS_PER_DAY ?? 300),
  },
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(JSON.stringify({ msg: "railkit api listening", port, corridors, save: save ? save.network : "off", prize: prize ? "on" : "off" }));
});

// Every 2 minutes: catch payments made after the app closed, and alert on stuck or failed orders.
setInterval(() => {
  watchOnce({
    store: ops,
    alert,
    refresh: async (o) =>
      o.kind === "payout"
        ? mavapay
          ? payoutToOps((await mavapay.getOrder(o.id)).state)
          : null
        : o.kind === "airtime"
          ? bitrefill
            ? airtimeToOps((await bitrefill.status(o.id)).state)
            : null
          : ramp
            ? rampToOps((await ramp.getOrder(o.id))?.state ?? "awaiting_payment")
            : null,
  }).catch((e) => console.error(JSON.stringify({ msg: "watcher failed", error: String(e) })));
}, 120_000);

if (prize) {
  const logLine = (msg: string, data?: Record<string, unknown>) => console.log(JSON.stringify({ msg, ...data }));
  const run = (what: string, job: () => Promise<unknown>) => void job().catch((e) => console.error(JSON.stringify({ msg: `${what} failed`, error: String(e) })));
  // Stakes are read now and then: drops are read from the chain itself, so these readings only catch rises.
  const checks = () => run("prize checks", () => checkStakes(prize, Date.now(), logLine));
  // The draw runs once its week's Sunday 23:59 has passed and the deciding block has settled.
  const draw = () =>
    run("prize draw", async () => {
      const d = await runDraw(prize, Date.now(), logLine);
      if (d?.winner) await alert(`Weekly draw ${d.week}: ${d.entries.length} savers, ${d.totalTickets} tickets. Winner ${d.winner}. Pay it with pnpm pay-prizes.`);
    });
  setTimeout(() => (checks(), draw()), 10_000);
  setInterval(checks, 15 * 60_000);
  setInterval(draw, 60_000);
}
