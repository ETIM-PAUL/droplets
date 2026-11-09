import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ProviderError, type BitrefillApi, type MavapayApi } from "@railkit/adapters";
import type { ChangellyFiatApi } from "@railkit/adapters/server";
import { understand, understandQr, type Bank, type Draft, type Extractor, type Missing, type QrExtractor, type SavingsClassifier, type SavingsPhraser } from "@railkit/agent";
import {
  CORRIDORS,
  isCorridorId,
  normalizePhone,
  parseNimiqAddress,
  parseBolt11,
  type CountryCode,
  validatePayoutAmount,
  validateRecipient,
  type PayoutRecipient,
} from "@railkit/core";
import { issueSession, overLimit, verifySession, type BetaConfig } from "./ops/beta";
import { airtimeToOps, payoutToOps, rampToOps } from "./ops/map";
import { betaMetrics } from "./ops/metrics";
import type { OpsStore } from "./ops/store";
import { rateLimiter } from "./rate-limit";
import { mountPrizeRoutes, type PrizeDeps } from "./prize/routes";
import { mountSaveRoutes, type SaveDeps } from "./save/routes";
import { verifyMavapaySignature } from "./webhook";

export interface AppDeps {
  /** Send to M-Pesa and banks. Off when undefined: the payout routes say so. */
  mavapay?: Pick<MavapayApi, "quote" | "getOrder" | "banks" | "nameEnquiry">;
  /** Corridor kill switch: only these are served. */
  corridors: ReadonlySet<string>;
  allowedOrigins: string[];
  webhookSecret?: string;
  bitrefill?: Pick<BitrefillApi, "lookup" | "quote" | "status" | "markStale">;
  /** Airtime kill switch: countries served, e.g. {"KE"}. */
  airtimeCountries?: ReadonlySet<string>;
  /** Secret path token for Bitrefill's (unsigned) webhooks. */
  bitrefillWebhookToken?: string;
  /** Server-side order log for alerts and metrics. */
  ops?: OpsStore;
  /** Closed beta: invite-only sessions and spending caps. Off when undefined. */
  beta?: BetaConfig;
  adminToken?: string;
  /** Practice mode: lets the app ask Mavapay STAGING to pretend an invoice was paid. Never on with live keys. */
  simulatePayIn?: (orderId: string) => Promise<void>;
  alert?: (text: string) => Promise<void>;
  /** Add money: Changelly's fiat on-ramp, the countries it's switched on for, and NIM's ticker there. */
  ramp?: { api: Pick<ChangellyFiatApi, "offers" | "validateAddress" | "createOrder" | "getOrder" | "readCallback">; countries: ReadonlySet<string>; nimTicker: string };
  /** Chat: an optional model for sentences the rules can't finish, capped per UTC day. */
  agent?: { model?: Extractor; qrModel?: QrExtractor; savingsPhraser?: SavingsPhraser; savingsClassifier?: SavingsClassifier; modelCallsPerDay?: number };
  /** Droplets: save codes and Grow. Off when undefined. */
  save?: SaveDeps;
  /** The weekly draw for people who keep savings in Grow. Off when undefined. The API holds no prize key. */
  prize?: PrizeDeps;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  now?: () => number;
}

type Env = { Variables: { invite: string | null } };

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const ORDER_ID = /^[0-9A-Za-z-]{6,64}$/;

const bad = (message: string, status: 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503 = 400) =>
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
  // The proxy in front of us (Render) appends the real client address last; earlier entries are whatever the client sent.
  const clientKey = (h: (n: string) => string | undefined) => h("x-forwarded-for")?.split(",").at(-1)?.trim() || "local";

  const providerError = (e: unknown) => {
    if (e instanceof ProviderError) return bad(e.message, e.status);
    log("unexpected error", { error: String(e) });
    return bad("Something went wrong on our side. Try again in a minute.", 502);
  };

  const payoutsOff = () => bad("Sending to M-Pesa and banks is switched off.", 503);

  const now = d.now ?? Date.now;
  const sessionLimit = rateLimiter(10, 60_000, d.now);

  const app = new Hono<Env>();
  app.use("/v1/*", cors({ origin: d.allowedOrigins, allowMethods: ["GET", "POST"], allowHeaders: ["Content-Type", "Authorization"] }));

  // Paid features need a beta session when the beta is on. The invite rides along for limits and metrics.
  const session = async (c: { req: { header(n: string): string | undefined }; set(k: "invite", v: string | null): void }, next: () => Promise<void>) => {
    if (!d.beta) {
      c.set("invite", null);
      return next();
    }
    const token = c.req.header("authorization")?.replace(/^Bearer /i, "");
    const invite = verifySession(token, d.beta, now());
    if (!invite) return bad("Your invite has ended or isn't valid. Enter your invite code again.", 401);
    c.set("invite", invite);
    return next();
  };
  for (const path of ["/v1/payouts/*", "/v1/airtime/*", "/v1/feedback", "/v1/agent/*", "/v1/topup/*"]) app.use(path, session as never);

  /** An order placed under another invite looks like it doesn't exist. */
  const notYours = async (id: string, invite: string | null) => {
    if (!d.ops || !d.beta) return false;
    const o = await d.ops.get(id);
    return !!o && o.invite !== invite;
  };

  app.post("/v1/session", async (c) => {
    if (!d.beta) return c.json({ token: null, name: null });
    if (!sessionLimit(clientKey((n) => c.req.header(n)))) return bad("Too many tries. Wait a minute.", 429);
    const body = (await c.req.json().catch(() => null)) as { invite?: unknown } | null;
    const code = typeof body?.invite === "string" ? body.invite.trim().toUpperCase() : "";
    if (!d.beta.invites.has(code)) return bad("That invite code isn't right. Check it and try again.", 401);
    log("beta session", { invite: code });
    return c.json({ token: issueSession(code, d.beta, now()), name: d.beta.invites.get(code) });
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/v1/corridors", (c) =>
    c.json({ corridors: Object.values(CORRIDORS).filter((x) => d.corridors.has(x.id)) }),
  );

  app.post("/v1/payouts/quote", async (c) => {
    if (!quoteLimit(clientKey((n) => c.req.header(n)))) return bad("Too many quotes in a short time. Wait a minute and try again.", 429);
    if (!d.mavapay) return payoutsOff();
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
      const invite = c.get("invite");
      if (d.beta && d.ops && invite) {
        const reason = await overLimit(invite, BigInt(q.sats), d.beta, d.ops, now());
        if (reason) return bad(reason, 403);
      }
      await d.ops?.recordQuote({
        id: q.orderId, kind: "payout", invite, product: corridor, receiveAmount: q.receive.amount,
        receiveCurrency: q.receive.currency, sats: q.sats, createdAt: now(), expiresAt: q.expiresAt,
      });
      log("payout quote", { corridor, orderId: q.orderId, sats: q.sats, invite });
      return c.json(q);
    } catch (e) {
      return providerError(e);
    }
  });

  app.get("/v1/payouts/orders/:orderId", async (c) => {
    if (!readLimit(clientKey((n) => c.req.header(n)))) return bad("Too many requests. Wait a minute.", 429);
    if (!d.mavapay) return payoutsOff();
    const id = c.req.param("orderId");
    if (!ORDER_ID.test(id)) return bad("That order number isn't valid.");
    if (await notYours(id, c.get("invite"))) return bad("Order not found.", 404);
    try {
      const status = await d.mavapay.getOrder(id);
      await d.ops?.setState(id, payoutToOps(status.state), now());
      return c.json(status);
    } catch (e) {
      return providerError(e);
    }
  });

  // The bank list changes rarely; one fetch an hour serves the picker and the chat.
  let bankCache: { at: number; banks: Bank[] } | null = null;
  const ngBanks = async (): Promise<Bank[]> => {
    if (bankCache && now() - bankCache.at < 3600_000) return bankCache.banks;
    if (!d.mavapay) return [];
    const seen = new Set<string>();
    const banks = (await d.mavapay.banks("NG")).filter((b) => !seen.has(b.code) && seen.add(b.code)).map((b) => ({ name: b.name.trim(), code: b.code }));
    bankCache = { at: now(), banks };
    return banks;
  };

  app.get("/v1/payouts/banks", async (c) => {
    if (c.req.query("country") !== "NG") return bad("Bank lists are available for NG only.");
    if (!d.mavapay) return payoutsOff();
    if (!d.corridors.has("ng-bank")) return bad("Nigerian bank payouts are paused right now.", 403);
    try {
      return c.json({ banks: await ngBanks() });
    } catch (e) {
      return providerError(e);
    }
  });

  app.get("/v1/payouts/name-enquiry", async (c) => {
    if (!readLimit(clientKey((n) => c.req.header(n)))) return bad("Too many requests. Wait a minute.", 429);
    if (!d.mavapay) return payoutsOff();
    const accountNumber = c.req.query("accountNumber") ?? "";
    const bankCode = c.req.query("bankCode") ?? "";
    if (!/^\d{10}$/.test(accountNumber) || !/^\d{3,10}$/.test(bankCode)) return bad("Enter a 10-digit account number and choose a bank.");
    try {
      return c.json(await d.mavapay.nameEnquiry(accountNumber, bankCode));
    } catch (e) {
      return providerError(e);
    }
  });

  const agentLimit = rateLimiter(20, 60_000, d.now);
  let modelDay = { day: "", calls: 0 };
  const allowModel = () => {
    const day = new Date(now()).toISOString().slice(0, 10);
    if (modelDay.day !== day) modelDay = { day, calls: 0 };
    if (modelDay.calls >= (d.agent?.modelCallsPerDay ?? 300)) return false;
    modelDay.calls++;
    return true;
  };
  const MISSING: Missing[] = ["corridor", "amount", "phone", "name", "bank", "account"];

  /** One chat turn: a sentence (or an answer to Droplets' last question) in, a checked draft and the next question out. */
  app.post("/v1/agent/understand", async (c) => {
    if (!agentLimit(clientKey((n) => c.req.header(n)))) return bad("Too many messages in a short time. Wait a minute.", 429);
    const body = (await c.req.json().catch(() => null)) as { text?: unknown; draft?: unknown; expecting?: unknown } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return bad("Type what you'd like to send.");
    if (text.length > 300) return bad("That's a long message. Say it in one sentence, under 300 characters.");
    const draft = body?.draft && typeof body.draft === "object" ? (body.draft as Draft) : undefined;
    const expecting = MISSING.find((m) => m === body?.expecting);
    let banks: Bank[] = [];
    if (d.corridors.has("ng-bank")) {
      try {
        banks = await ngBanks();
      } catch (e) {
        log("agent bank list failed", { error: String(e) });
      }
    }
    const enabled = new Set([...d.corridors].filter(isCorridorId));
    // The model only finishes payment sentences. With no corridor served there's nothing to finish, so no model call.
    const model = enabled.size > 0 ? d.agent?.model : undefined;
    const r = await understand({ text, draft, expecting }, { enabled, banks, model, savingsClassifier: d.agent?.savingsClassifier, allowModel, log });
    // The message itself is not logged: it holds names and numbers.
    log("agent turn", { intent: r.intent ?? "send", source: r.source, missing: r.missing, invite: c.get("invite") });
    return c.json(r);
  });

  /** A QR the phone's own parsers couldn't read: the rules again, then the model, re-checked by the parser. */
  app.post("/v1/agent/qr", async (c) => {
    if (!agentLimit(clientKey((n) => c.req.header(n)))) return bad("Too many scans in a short time. Wait a minute.", 429);
    const body = (await c.req.json().catch(() => null)) as { text?: unknown; network?: unknown } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return bad("The QR code was empty.");
    if (text.length > 4096) return bad("That QR code holds too much text to be a payment request.");
    const hostNetwork = body?.network === "testnet" ? "testnet" : "mainnet";
    const r = await understandQr(text, { model: d.agent?.qrModel, allowModel, now: now(), hostNetwork, log });
    log("agent qr", { status: r.status, source: r.source, kind: r.payment?.kind ?? null });
    return c.json(r);
  });

  // ---- Add money (Changelly Fiat API). The user pays on the provider's page; NIM goes straight to their address.
  const RAMP_FIAT: Record<string, string> = { NG: "NGN", KE: "KES", GH: "GHS", ZA: "ZAR" };

  /** Checks a top-up request's country, amount and address. Returns an error response or the clean values. */
  function readTopup(b: Record<string, unknown> | null) {
    const country = typeof b?.country === "string" ? b.country.toUpperCase() : "";
    if (!d.ramp || !d.ramp.countries.has(country) || !RAMP_FIAT[country]) return { error: bad("Adding money isn't available in your country yet.", 403) };
    const amount = typeof b?.amount === "string" ? b.amount.trim() : "";
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) return { error: bad(`Enter an amount in ${RAMP_FIAT[country]}.`) };
    const addr = parseNimiqAddress(typeof b?.walletAddress === "string" ? b.walletAddress : "");
    if (!addr.ok) return { error: bad(addr.error.message) };
    const userId = typeof b?.userId === "string" && /^[\w-]{8,64}$/.test(b.userId) ? b.userId : null;
    return { country, fiat: RAMP_FIAT[country]!, amount, walletAddress: addr.value, userId };
  }

  app.get("/v1/topup/options", (c) =>
    c.json({ countries: d.ramp ? [...d.ramp.countries].filter((x) => RAMP_FIAT[x]).map((country) => ({ country, currency: RAMP_FIAT[country] })) : [] }),
  );

  app.post("/v1/topup/offers", async (c) => {
    if (!quoteLimit(clientKey((n) => c.req.header(n)))) return bad("Too many requests in a short time. Wait a minute and try again.", 429);
    const t = readTopup((await c.req.json().catch(() => null)) as Record<string, unknown> | null);
    if ("error" in t) return t.error;
    try {
      const ip = clientKey((n) => c.req.header(n));
      const r = await d.ramp!.api.offers({ currencyFrom: t.fiat, currencyTo: d.ramp!.nimTicker, amountFrom: t.amount, country: t.country, ...(ip !== "local" ? { ip } : {}) });
      return c.json({ currency: t.fiat, ...r });
    } catch (e) {
      return providerError(e);
    }
  });

  app.post("/v1/topup/orders", async (c) => {
    if (!quoteLimit(clientKey((n) => c.req.header(n)))) return bad("Too many requests in a short time. Wait a minute and try again.", 429);
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const t = readTopup(b);
    if ("error" in t) return t.error;
    const providerCode = typeof b?.providerCode === "string" && /^[a-z0-9_-]{2,32}$/i.test(b.providerCode) ? b.providerCode : "";
    if (!providerCode) return bad("Choose an offer first.");
    const paymentMethod = typeof b?.paymentMethod === "string" && /^[a-z0-9_-]{2,40}$/i.test(b.paymentMethod) ? b.paymentMethod : undefined;
    const invite = c.get("invite");
    try {
      if (!(await d.ramp!.api.validateAddress(d.ramp!.nimTicker, t.walletAddress))) return bad("The provider can't send NIM to that address. Check it in Nimiq Pay.");
      const ip = clientKey((n) => c.req.header(n));
      const order = await d.ramp!.api.createOrder({
        externalOrderId: randomUUID(),
        externalUserId: invite ?? t.userId ?? "errand-user",
        providerCode,
        currencyFrom: t.fiat,
        currencyTo: d.ramp!.nimTicker,
        amountFrom: t.amount,
        country: t.country,
        walletAddress: t.walletAddress,
        ...(paymentMethod ? { paymentMethod } : {}),
        ...(ip !== "local" ? { ip } : {}),
      });
      await d.ops?.recordQuote({
        id: order.externalOrderId, kind: "topup", invite, product: `${providerCode}:${t.country}`, receiveAmount: t.amount,
        receiveCurrency: t.fiat, sats: "0", createdAt: now(), expiresAt: now() + 60 * 60_000,
      });
      log("topup order", { orderId: order.externalOrderId, providerCode, country: t.country, invite });
      return c.json({ orderId: order.externalOrderId, redirectUrl: order.redirectUrl });
    } catch (e) {
      return providerError(e);
    }
  });

  app.get("/v1/topup/orders/:orderId", async (c) => {
    if (!d.ramp) return bad("Adding money isn't available right now.", 503);
    if (!readLimit(clientKey((n) => c.req.header(n)))) return bad("Too many requests. Wait a minute.", 429);
    const id = c.req.param("orderId");
    if (!ORDER_ID.test(id)) return bad("That order number isn't valid.");
    if (await notYours(id, c.get("invite"))) return bad("Order not found.", 404);
    try {
      const s = await d.ramp.api.getOrder(id);
      if (!s) return c.json({ orderId: id, state: "awaiting_payment", payoutAmount: null, transactionHash: null });
      await d.ops?.setState(id, rampToOps(s.state), now());
      return c.json({ orderId: id, state: s.state, payoutAmount: s.payoutAmount, transactionHash: s.transactionHash });
    } catch (e) {
      return providerError(e);
    }
  });

  // Changelly signs {"orderId": ...} with its key; anything else is ignored.
  app.post("/v1/webhooks/changelly", async (c) => {
    if (!d.ramp) return bad("Not found.", 404);
    const raw = await c.req.text();
    const s = d.ramp.api.readCallback({ apiKey: c.req.header("x-callback-api-key"), signature: c.req.header("x-callback-signature") }, raw);
    if (!s || !ORDER_ID.test(s.externalOrderId)) return bad("Bad signature.", 400);
    await d.ops?.setState(s.externalOrderId, rampToOps(s.state), now());
    log("topup webhook", { orderId: s.externalOrderId, status: s.status });
    if (s.state === "hold") {
      await d.alert?.(`TOPUP ON HOLD: the provider needs the user to act (often an ID check): topup ${s.externalOrderId}`).catch(() => undefined);
    }
    return c.json({ ok: true });
  });

  const airtimeCountry = (c: string | undefined): CountryCode | null =>
    c && ["KE", "NG", "GH", "ZA"].includes(c) && d.airtimeCountries?.has(c) ? (c as CountryCode) : null;

  app.get("/v1/airtime/lookup", async (c) => {
    if (!d.bitrefill) return bad("Top-ups aren't available yet.", 503);
    if (!readLimit(clientKey((n) => c.req.header(n)))) return bad("Too many requests. Wait a minute.", 429);
    const country = airtimeCountry(c.req.query("country"));
    if (!country) return bad("Top-ups for this country are paused right now.", 403);
    const phone = normalizePhone(c.req.query("phone") ?? "", country);
    if (!phone.ok) return bad(phone.error.message);
    try {
      return c.json({ phone: phone.value, operator: await d.bitrefill.lookup(phone.value) });
    } catch (e) {
      return providerError(e);
    }
  });

  app.post("/v1/airtime/quote", async (c) => {
    if (!d.bitrefill) return bad("Top-ups aren't available yet.", 503);
    if (!quoteLimit(clientKey((n) => c.req.header(n)))) return bad("Too many quotes in a short time. Wait a minute and try again.", 429);
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return bad("Send the quote request as JSON.");
    }
    const country = airtimeCountry(typeof body.country === "string" ? body.country : undefined);
    if (!country) return bad("Top-ups for this country are paused right now.", 403);
    const phone = normalizePhone(typeof body.phone === "string" ? body.phone : "", country);
    if (!phone.ok) return bad(phone.error.message);
    const amount = body.amount as { amount?: unknown; currency?: unknown } | undefined;
    if (typeof body.operatorId !== "string" || typeof amount?.amount !== "string" || typeof amount.currency !== "string") {
      return bad("Choose a network and an amount.");
    }
    try {
      const q = await d.bitrefill.quote({ phone: phone.value, operatorId: body.operatorId, amount: { amount: amount.amount, currency: amount.currency } });
      const invite = c.get("invite");
      if (d.beta && d.ops && invite) {
        const reason = await overLimit(invite, BigInt(q.sats), d.beta, d.ops, now());
        if (reason) return bad(reason, 403);
      }
      const inv = parseBolt11(q.invoice);
      await d.ops?.recordQuote({
        id: q.invoiceId, kind: "airtime", invite, product: country, receiveAmount: q.receive.amount, receiveCurrency: q.receive.currency,
        sats: q.sats, createdAt: now(), expiresAt: inv.ok ? inv.value.expiresAt * 1000 : now() + 30 * 60_000,
      });
      log("airtime quote", { country, invoiceId: q.invoiceId, sats: q.sats, invite });
      return c.json(q);
    } catch (e) {
      return providerError(e);
    }
  });

  app.get("/v1/airtime/invoices/:invoiceId", async (c) => {
    if (!d.bitrefill) return bad("Top-ups aren't available yet.", 503);
    if (!readLimit(clientKey((n) => c.req.header(n)))) return bad("Too many requests. Wait a minute.", 429);
    const id = c.req.param("invoiceId");
    if (!/^[0-9a-f-]{36}$/.test(id)) return bad("That invoice number isn't valid.");
    if (await notYours(id, c.get("invite"))) return bad("Order not found.", 404);
    try {
      const status = await d.bitrefill.status(id);
      await d.ops?.setState(id, airtimeToOps(status.state), now());
      return c.json(status);
    } catch (e) {
      return providerError(e);
    }
  });

  app.post("/v1/webhooks/bitrefill/:token", async (c) => {
    // Bitrefill doesn't sign webhooks: the secret path token stops strangers, and we only use the
    // payload to decide which invoice to re-check from Bitrefill's API, never as the truth.
    const token = d.bitrefillWebhookToken;
    if (!token || !d.bitrefill) return bad("Webhooks aren't configured.", 503);
    const given = c.req.param("token");
    if (given.length !== token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(token))) return bad("Not found.", 404);
    const evt = (await c.req.json().catch(() => null)) as { id?: unknown } | null;
    if (typeof evt?.id === "string" && /^[0-9a-f-]{36}$/.test(evt.id)) {
      d.bitrefill.markStale(evt.id);
      log("bitrefill webhook", { invoiceId: evt.id });
    }
    return c.json({ received: true });
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

  app.post("/v1/dev/simulate-payment/:orderId", async (c) => {
    if (!d.simulatePayIn) return bad("Not found.", 404);
    const id = c.req.param("orderId");
    if (!ORDER_ID.test(id)) return bad("That order number isn't valid.");
    const known = await d.ops?.get(id);
    if (known && now() >= known.expiresAt) return bad("This price has expired. Get a new price to see the current one.");
    try {
      await d.simulatePayIn(id);
      log("practice payment", { orderId: id });
      return c.json({ simulated: true });
    } catch (e) {
      return providerError(e);
    }
  });

  app.post("/v1/feedback", async (c) => {
    if (!d.ops) return bad("Feedback isn't available right now.", 503);
    if (!readLimit(clientKey((n) => c.req.header(n)))) return bad("Too many requests. Wait a minute.", 429);
    const body = (await c.req.json().catch(() => null)) as { message?: unknown; orderId?: unknown } | null;
    const message = typeof body?.message === "string" ? body.message.trim().slice(0, 2000) : "";
    if (!message) return bad("Tell us what happened.");
    const orderId = typeof body?.orderId === "string" && ORDER_ID.test(body.orderId) ? body.orderId : null;
    const invite = c.get("invite");
    await d.ops.addFeedback({ id: randomUUID(), invite, orderId, message, createdAt: now() });
    // Untrusted text: quoted, never interpreted.
    await d.alert?.(`FEEDBACK from ${invite ?? "anonymous"}${orderId ? ` on ${orderId}` : ""}: ${JSON.stringify(message)}`).catch(() => undefined);
    return c.json({ received: true });
  });

  const admin = (h: string | undefined) => !!d.adminToken && !!h && safeEqual(h.replace(/^Bearer /i, ""), d.adminToken);

  app.get("/v1/admin/metrics", async (c) => {
    if (!admin(c.req.header("authorization")) || !d.ops) return bad("Not found.", 404);
    return c.json(betaMetrics(await d.ops.listSince(0), now()));
  });

  app.get("/v1/admin/orders", async (c) => {
    if (!admin(c.req.header("authorization")) || !d.ops) return bad("Not found.", 404);
    const days = Math.min(Number(c.req.query("days") ?? 7) || 7, 90);
    const state = c.req.query("state");
    const list = await d.ops.listSince(now() - days * 86_400_000);
    return c.json({ orders: state ? list.filter((o) => o.state === state) : list });
  });

  app.get("/v1/admin/feedback", async (c) => {
    if (!admin(c.req.header("authorization")) || !d.ops) return bad("Not found.", 404);
    return c.json({ feedback: await d.ops.listFeedback(now() - 30 * 86_400_000) });
  });

  if (d.save) mountSaveRoutes(app, d.save, { bad, clientKey, admin, now, log, phraser: d.agent?.savingsPhraser, classifier: d.agent?.savingsClassifier, allowModel });
  else app.all("/v1/save/*", () => bad("Savings is switched off on this server.", 503));
  if (d.prize) mountPrizeRoutes(app, d.prize, { bad, clientKey, admin, now, log });
  else app.all("/v1/prize/*", () => bad("The weekly draw is switched off on this server.", 503));

  return app;
}
