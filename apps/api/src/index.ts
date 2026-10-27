import { serve } from "@hono/node-server";
import { createBitrefillApi, createMavapayApi } from "@railkit/adapters";
import { createApp } from "./app";

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

const app = createApp({
  bitrefill,
  airtimeCountries: new Set(list(process.env.AIRTIME_COUNTRIES)),
  bitrefillWebhookToken: bitrefillToken,
  mavapay: createMavapayApi({ apiKey: required("MAVAPAY_API_KEY"), baseUrl: required("MAVAPAY_BASE_URL") }),
  corridors: new Set(list(process.env.CORRIDORS)),
  allowedOrigins: list(process.env.ALLOWED_ORIGINS),
  webhookSecret: process.env.MAVAPAY_WEBHOOK_SECRET || undefined,
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(JSON.stringify({ msg: "railkit api listening", port, corridors: list(process.env.CORRIDORS) }));
});
