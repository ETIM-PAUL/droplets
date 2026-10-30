import { serve } from "@hono/node-server";
import { createBitrefillApi, createMavapayApi, ProviderError } from "@railkit/adapters";
import pg from "pg";
import { openAiExtractor, openAiQrExtractor } from "@railkit/agent";
import { createApp } from "./app";
import { parseInvites, type BetaConfig } from "./ops/beta";
import { airtimeToOps, payoutToOps } from "./ops/map";
import { MemoryOpsStore, PgOpsStore, type OpsStore } from "./ops/store";
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

const mavapay = createMavapayApi({ apiKey: required("MAVAPAY_API_KEY"), baseUrl: required("MAVAPAY_BASE_URL") });

let ops: OpsStore;
if (process.env.DATABASE_URL) {
  const store = new PgOpsStore(new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 }));
  await store.migrate();
  ops = store;
} else {
  console.warn(JSON.stringify({ msg: "DATABASE_URL not set: order log is in memory and lost on restart" }));
  ops = new MemoryOpsStore();
}

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
  corridors: new Set(list(process.env.CORRIDORS)),
  allowedOrigins: list(process.env.ALLOWED_ORIGINS),
  webhookSecret: process.env.MAVAPAY_WEBHOOK_SECRET || undefined,
  agent: {
    model: process.env.OPENAI_API_KEY ? openAiExtractor({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || undefined }) : undefined,
    qrModel: process.env.OPENAI_API_KEY ? openAiQrExtractor({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || undefined }) : undefined,
    modelCallsPerDay: Number(process.env.AGENT_MODEL_CALLS_PER_DAY ?? 300),
  },
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(JSON.stringify({ msg: "railkit api listening", port, corridors: list(process.env.CORRIDORS) }));
});

// Every 2 minutes: catch payments made after the app closed, and alert on stuck or failed orders.
setInterval(() => {
  watchOnce({
    store: ops,
    alert,
    refresh: async (o) =>
      o.kind === "payout"
        ? payoutToOps((await mavapay.getOrder(o.id)).state)
        : bitrefill
          ? airtimeToOps((await bitrefill.status(o.id)).state)
          : null,
  }).catch((e) => console.error(JSON.stringify({ msg: "watcher failed", error: String(e) })));
}, 120_000);
