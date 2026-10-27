import { serve } from "@hono/node-server";
import { createMavapayApi } from "@railkit/adapters";
import { createApp } from "./app";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const app = createApp({
  mavapay: createMavapayApi({ apiKey: required("MAVAPAY_API_KEY"), baseUrl: required("MAVAPAY_BASE_URL") }),
  corridors: new Set(list(process.env.CORRIDORS)),
  allowedOrigins: list(process.env.ALLOWED_ORIGINS),
  webhookSecret: process.env.MAVAPAY_WEBHOOK_SECRET || undefined,
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(JSON.stringify({ msg: "railkit api listening", port, corridors: list(process.env.CORRIDORS) }));
});
