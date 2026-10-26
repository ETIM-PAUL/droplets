import { isExpired } from "../bolt11";
import { compareMoney } from "../money";
import { parsePaymentInput } from "../parse";
import { fail, ok, type Result } from "../result";
import { transition } from "./machine";
import {
  WalletError,
  type HostNetwork,
  type Order,
  type OrderStore,
  type PayIntent,
  type Quote,
  type RouteAdapter,
  type Asset,
  type WalletExecutor,
} from "./types";

export interface EngineOptions {
  routes: RouteAdapter[];
  store: OrderStore;
  network: HostNetwork;
  now?: () => number;
  newId?: () => string;
}

export class Engine {
  private routes: RouteAdapter[];
  private store: OrderStore;
  private network: HostNetwork;
  private now: () => number;
  private newId: () => string;

  constructor(o: EngineOptions) {
    this.routes = o.routes;
    this.store = o.store;
    this.network = o.network;
    this.now = o.now ?? Date.now;
    this.newId = o.newId ?? (() => crypto.randomUUID());
  }

  /** Turns pasted text or a scanned QR into a typed intent, or says what's wrong. */
  resolve(input: string, sourceAsset: Asset): Result<PayIntent> {
    const parsed = parsePaymentInput(input);
    if (!parsed.ok) return parsed;
    const d = parsed.value;

    if (d.kind === "bolt11") {
      const want = this.network === "mainnet" ? "mainnet" : "testnet";
      if (d.network !== want) {
        return fail("unsupported", `This invoice is for ${d.network}, but Nimiq Pay is on ${this.network}. Ask for an invoice on the right network.`);
      }
      if (isExpired(d, Math.floor(this.now() / 1000))) {
        return fail("unsupported", "This invoice has expired. Ask the sender for a new one.");
      }
    }
    return ok({ kind: "pay", destination: d, sourceAsset });
  }

  /** Quotes every route that can handle the intent, cheapest first. */
  async quote(intent: PayIntent): Promise<Result<Quote[]>> {
    const candidates = this.routes.filter((r) => r.canHandle(intent));
    if (candidates.length === 0) {
      return fail("unsupported", "Errand can't pay this yet. Try a different payment request.");
    }
    const settled = await Promise.allSettled(candidates.map((r) => r.quote(intent)));
    const quotes: Quote[] = [];
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") {
        quotes.push({ ...s.value, id: this.newId(), routeId: candidates[i]!.id, intent });
      }
    });
    if (quotes.length === 0) {
      return fail("unsupported", "No route is available right now. Try again in a minute.");
    }
    quotes.sort((a, b) => compareMoney(a.send, b.send) || a.etaSeconds - b.etaSeconds);
    return ok(quotes);
  }

  async createOrder(quote: Quote): Promise<Result<Order>> {
    const t = this.now();
    if (t >= quote.expiresAt) return fail("unsupported", "This quote has expired. Get a new one to see the current price.");
    const order: Order = {
      id: this.newId(),
      quote,
      state: "awaiting_approval",
      timeline: [{ at: t, from: null, to: "awaiting_approval" }],
      stepRefs: [],
      createdAt: t,
      updatedAt: t,
      message: null,
    };
    await this.store.put(order);
    return ok(order);
  }

  /** Runs the quote's steps through the wallet. The native dialog is the executor's job. */
  async approve(orderId: string, wallet: WalletExecutor): Promise<Order> {
    let order = await this.mustGet(orderId);
    if (order.state !== "awaiting_approval") return order; // double taps and replays change nothing

    if (this.now() >= order.quote.expiresAt) {
      order = transition(order, "expired", this.now(), "quote expired before approval", "This quote expired before you approved it. Nothing was sent. Get a new quote.");
      await this.store.put(order);
      return order;
    }

    order = transition(order, "submitting", this.now());
    await this.store.put(order);

    const route = this.routes.find((r) => r.id === order.quote.routeId)!;
    const refs: string[] = [];
    try {
      const { providerRef } = await route.open(order.quote);
      order = { ...order, quote: { ...order.quote, providerRef } };
      for (const step of order.quote.steps) refs.push((await wallet.execute(step)).ref);
    } catch (e) {
      let kind = e instanceof WalletError ? e.kind : "failed";
      // If an earlier step already moved money, "nothing was sent" would be a lie.
      if (kind === "failed" && refs.length > 0) kind = "unknown";
      order = { ...order, stepRefs: refs };
      if (kind === "rejected") {
        order = transition(order, "cancelled", this.now(), "user declined", "You cancelled this payment. Nothing was sent.");
      } else if (kind === "unknown") {
        order = transition(
          order,
          "outcome_unknown",
          this.now(),
          String(e),
          "We can't tell if this payment went through. Don't pay again yet; check your wallet history or contact support.",
        );
      } else {
        order = transition(order, "failed", this.now(), String(e), "The payment didn't go through and nothing was sent. You can try again.");
      }
      await this.store.put(order);
      return order;
    }

    order = transition({ ...order, stepRefs: refs }, "processing", this.now());
    await this.store.put(order);
    return order;
  }

  /** Asks the provider where a processing order is, and moves it on. */
  async poll(orderId: string): Promise<Order> {
    let order = await this.mustGet(orderId);
    if (order.state !== "processing" && order.state !== "outcome_unknown") return order;
    if (!order.quote.providerRef) return order;

    const route = this.routes.find((r) => r.id === order.quote.routeId)!;
    const s = await route.poll(order.quote.providerRef);
    if (s.status === "completed") {
      if (order.state === "outcome_unknown") order = transition(order, "processing", this.now(), "provider confirmed payment");
      order = transition(order, "completed", this.now());
    } else if (s.status === "failed") {
      order = transition(order, "failed", this.now(), s.message, `The payment failed: ${s.message}. Contact support with your order number ${order.id}.`);
    } else if (order.state === "outcome_unknown" && s.status === "processing") {
      order = transition(order, "processing", this.now(), "provider has the payment");
    } else {
      return order;
    }
    await this.store.put(order);
    return order;
  }

  async cancel(orderId: string): Promise<Order> {
    const order = await this.mustGet(orderId);
    if (order.state !== "awaiting_approval") return order;
    const next = transition(order, "cancelled", this.now(), "cancelled before approval", "Cancelled. Nothing was sent.");
    await this.store.put(next);
    return next;
  }

  private async mustGet(id: string): Promise<Order> {
    const o = await this.store.get(id);
    if (!o) throw new Error(`Unknown order ${id}`);
    return o;
  }
}
