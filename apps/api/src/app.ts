import { Hono } from "hono";
import { cors } from "hono/cors";
import { ProviderError, type MavapayApi } from "@railkit/adapters";
import {
  CORRIDORS,
  isCorridorId,
  validatePayoutAmount,
  validateRecipient,
  type PayoutRecipient,
} from "@railkit/core";
import { rateLimiter } from "./rate-limit";
import { verifyMavapaySignature } from "./webhook";

export interface AppDeps {
  mavapay: Pick<MavapayApi, "quote" | "getOrder" | "banks" | "nameEnquiry">;
  /** Corridor kill switch: only these are served. */
  corridors: ReadonlySet<string>;
  allowedOrigins: string[];
  webhookSecret?: string;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  now?: () => number;
}

const ORDER_ID = /^[0-9A-Za-z-]{6,64}$/;

const bad = (message: string, status: 400 | 403 | 404 | 429 | 502 | 503 = 400) =>
  Response.json({ error: { message } }, { status });

function readRecipient(x: unknown): PayoutRecipient | null {
  if (typeof x !== "object" || x === null) return null;
  const r = x as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : "");
  if (r.type === "mobile-money") {
    return { type: "mobile-money", phone: str("phone"), name: str("name"), network: str("network") as "mpesa" };
  }
  if (r.type === "bank") {
    return { type: "bank", bankCode: str("bankCode") || undefined, bankName: str("bankName"), accountNumber: str("accountNumber"), accountName: str("accountName") };
  }
  return null;
}

export function createApp(d: AppDeps) {
  const log = d.log ?? ((msg, data) => console.log(JSON.stringify({ msg, ...data })));
  const quoteLimit = rateLimiter(20, 60_000, d.now);
  const readLimit = rateLimiter(120, 60_000, d.now);
  const clientKey = (h: (n: string) => string | undefined) => h("x-forwarded-for")?.split(",")[0]?.trim() || "local";

  const providerError = (e: unknown) => {
    if (e instanceof ProviderError) return bad(e.message, e.status);
    log("unexpected error", { error: String(e) });
    return bad("Something went wrong on our side. Try again in a minute.", 502);
  };

  const app = new Hono();
  app.use("/v1/*", cors({ origin: d.allowedOrigins, allowMethods: ["GET", "POST"], allowHeaders: ["Content-Type"] }));

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/v1/corridors", (c) =>
    c.json({ corridors: Object.values(CORRIDORS).filter((x) => d.corridors.has(x.id)) }),
  );

  app.post("/v1/payouts/quote", async (c) => {
    if (!quoteLimit(clientKey((n) => c.req.header(n)))) return bad("Too many quotes in a short time. Wait a minute and try again.", 429);
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return bad("Send the quote request as JSON.");
    }
    const corridor = typeof body.corridor === "string" ? body.corridor : "";
    if (!isCorridorId(corridor)) return bad("Unknown corridor.");
    if (!d.corridors.has(corridor)) return bad(`${CORRIDORS[corridor].label} is paused right now. Try again later.`, 403);

    const amountIn = body.amount as { amount?: unknown; currency?: unknown } | undefined;
    if (typeof amountIn?.amount !== "string" || typeof amountIn.currency !== "string") return bad("Enter an amount.");
    const amount = validatePayoutAmount(corridor, { amount: amountIn.amount, currency: amountIn.currency });
    if (!amount.ok) return bad(amount.error.message);

    const rawRecipient = readRecipient(body.recipient);
    if (!rawRecipient) return bad("Enter the recipient's details.");
    const recipient = validateRecipient(corridor, rawRecipient);
    if (!recipient.ok) return bad(recipient.error.message);

    try {
      const q = await d.mavapay.quote({ corridor, amount: amount.value, recipient: recipient.value });
      log("payout quote", { corridor, orderId: q.orderId, sats: q.sats });
      return c.json(q);
    } catch (e) {
      return providerError(e);
    }
  });

  app.get("/v1/payouts/orders/:orderId", async (c) => {
    if (!readLimit(clientKey((n) => c.req.header(n)))) return bad("Too many requests. Wait a minute.", 429);
    const id = c.req.param("orderId");
    if (!ORDER_ID.test(id)) return bad("That order number isn't valid.");
    try {
      return c.json(await d.mavapay.getOrder(id));
    } catch (e) {
      return providerError(e);
    }
  });

  app.get("/v1/payouts/banks", async (c) => {
    if (c.req.query("country") !== "NG") return bad("Bank lists are available for NG only.");
    if (!d.corridors.has("ng-bank")) return bad("Nigerian bank payouts are paused right now.", 403);
    try {
      return c.json({ banks: await d.mavapay.banks("NG") });
    } catch (e) {
      return providerError(e);
    }
  });

  app.get("/v1/payouts/name-enquiry", async (c) => {
    if (!readLimit(clientKey((n) => c.req.header(n)))) return bad("Too many requests. Wait a minute.", 429);
    const accountNumber = c.req.query("accountNumber") ?? "";
    const bankCode = c.req.query("bankCode") ?? "";
    if (!/^\d{10}$/.test(accountNumber) || !/^\d{3,10}$/.test(bankCode)) return bad("Enter a 10-digit account number and choose a bank.");
    try {
      return c.json(await d.mavapay.nameEnquiry(accountNumber, bankCode));
    } catch (e) {
      return providerError(e);
    }
  });

  app.post("/v1/webhooks/mavapay", async (c) => {
    if (!d.webhookSecret) return bad("Webhooks aren't configured.", 503);
    const raw = await c.req.text();
    if (!verifyMavapaySignature(raw, c.req.header("x-mavapay-signature"), d.webhookSecret)) return bad("Invalid signature.", 403);
    try {
      const evt = JSON.parse(raw) as { event?: string; data?: { id?: string; status?: string; metadata?: { orderId?: string } } };
      // Polling stays the source of truth for now; webhooks are logged so we can reconcile and alert.
      log("mavapay webhook", { event: evt.event, id: evt.data?.id, status: evt.data?.status, orderId: evt.data?.metadata?.orderId });
    } catch {
      return bad("Invalid JSON.");
    }
    return c.json({ received: true });
  });

  return app;
}
