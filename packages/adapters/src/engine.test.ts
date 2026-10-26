import {
  Engine,
  MemoryOrderStore,
  WalletError,
  parseBolt11,
  stuckReason,
  transition,
  type Order,
  type Step,
  type WalletExecutor,
} from "@railkit/core";
import { describe, expect, it } from "vitest";
import { mockLightningRoute, type MockRouteOptions } from "./mock-route";

// A real Bitrefill invoice (4,834 sats), issued 2026-10-26, 30 minute expiry.
const INVOICE =
  "lnbc48340n1p4d7u40pp59lnhcn8zm6dv9658k9nu4z34as4rp5fnzkkjnrtnh2gm6076ay3qdz2gf5hgun9ve5kcmpqxqukywtzxgcnvtfnvd3nqtf58ymnqtfcxqenytfcxesnjdesv4snxv3nvccqzxgxqrpcgsp5au067n3zqlmk6efxjrz2muc0kv6exel3kr607pnl9snfqk9ckngs9qxpqysgq7qmq5c9apmd0f5nss4ztn2lgl6mdtcnutjyz6ctxfrnsr4vj2c5jf3nu0zfu5qm4ajpq6uyck6uwm2f2yfep5qz27sqy740afg62j4qpmzqnvg";
const T0 = 1_793_028_800_000; // shortly after the invoice was issued

function setup(route: MockRouteOptions = {}, network: "mainnet" | "testnet" = "mainnet") {
  let t = T0;
  let n = 0;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const adapter = mockLightningRoute({ now: clock.now, ...route });
  const engine = new Engine({
    routes: [adapter],
    store: new MemoryOrderStore(),
    network,
    now: clock.now,
    newId: () => `id-${++n}`,
  });
  return { engine, clock, adapter };
}

const wallet = (behaviour: (s: Step, i: number) => void = () => {}): WalletExecutor & { steps: Step[] } => {
  const steps: Step[] = [];
  return {
    steps,
    async execute(step) {
      behaviour(step, steps.length);
      steps.push(step);
      return { ref: `tx-${steps.length}` };
    },
  };
};

async function quoted(h: ReturnType<typeof setup>) {
  const intent = h.engine.resolve(INVOICE, "NIM");
  if (!intent.ok) throw new Error(intent.error.message);
  const q = await h.engine.quote(intent.value);
  if (!q.ok) throw new Error(q.error.message);
  const o = await h.engine.createOrder(q.value[0]!);
  if (!o.ok) throw new Error(o.error.message);
  return { quote: q.value[0]!, order: o.value };
}

describe("resolve", () => {
  it("builds a typed intent from an invoice", () => {
    const r = setup().engine.resolve(INVOICE, "NIM");
    expect(r.ok && r.value.kind).toBe("pay");
  });
  it("refuses a mainnet invoice on a testnet host, with next steps", () => {
    const r = setup({}, "testnet").engine.resolve(INVOICE, "NIM");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/mainnet.*testnet/);
  });
  it("refuses an expired invoice", () => {
    const h = setup();
    h.clock.advance(3 * 3600_000);
    const r = h.engine.resolve(INVOICE, "NIM");
    expect(r.ok).toBe(false);
  });
  it("passes parser errors through", () => {
    expect(setup().engine.resolve("nonsense", "NIM").ok).toBe(false);
  });
});

describe("quote", () => {
  it("returns a priced, expiring quote with decimal-string money", async () => {
    const { quote } = await quoted(setup());
    expect(quote.receive).toEqual({ amount: "4834", currency: "SAT" });
    expect(quote.fee).toEqual({ amount: "49", currency: "SAT" }); // 1% of 4834 rounded up
    expect(quote.send).toEqual({ amount: "4883", currency: "SAT" });
    expect(quote.expiresAt).toBe(T0 + 60_000);
    expect(quote.steps).toEqual([{ kind: "pay-lightning-invoice", invoice: INVOICE }]);
  });
  it("says so when no route can pay", async () => {
    const h = setup();
    const intent = h.engine.resolve("paul@example.com", "NIM");
    if (!intent.ok) throw new Error();
    const q = await h.engine.quote(intent.value);
    expect(q.ok).toBe(false);
  });
  it("won't make an order from an expired quote", async () => {
    const h = setup();
    const { quote } = await quoted(h);
    h.clock.advance(61_000);
    const o = await h.engine.createOrder(quote);
    expect(o.ok).toBe(false);
  });
});

describe("order lifecycle on the mock route", () => {
  it("runs resolve, quote, order, approve and completion end to end", async () => {
    const h = setup();
    const { order } = await quoted(h);
    const w = wallet();

    let o = await h.engine.approve(order.id, w);
    expect(o.state).toBe("processing");
    expect(w.steps).toHaveLength(1);
    expect(o.stepRefs).toEqual(["tx-1"]);
    expect(o.quote.providerRef).toMatch(/^mock-/);

    o = await h.engine.poll(order.id); // pending
    expect(o.state).toBe("processing");
    o = await h.engine.poll(order.id); // processing
    expect(o.state).toBe("processing");
    o = await h.engine.poll(order.id); // completed
    expect(o.state).toBe("completed");

    expect(o.timeline.map((t) => t.to)).toEqual(["awaiting_approval", "submitting", "processing", "completed"]);
  });

  it("ignores a second approval", async () => {
    const h = setup();
    const { order } = await quoted(h);
    const w = wallet();
    await h.engine.approve(order.id, w);
    await h.engine.approve(order.id, w);
    expect(w.steps).toHaveLength(1);
  });

  it("expires an order approved after its quote lapsed, without touching the wallet", async () => {
    const h = setup();
    const { order } = await quoted(h);
    h.clock.advance(61_000);
    const w = wallet();
    const o = await h.engine.approve(order.id, w);
    expect(o.state).toBe("expired");
    expect(w.steps).toHaveLength(0);
    expect(o.message).toMatch(/Nothing was sent/);
  });

  it("cancels when the user declines in the wallet dialog", async () => {
    const h = setup();
    const { order } = await quoted(h);
    const o = await h.engine.approve(order.id, wallet(() => {
      throw new WalletError("rejected", "declined");
    }));
    expect(o.state).toBe("cancelled");
    expect(o.message).toMatch(/Nothing was sent/);
  });

  it("holds an uncertain outcome and warns against paying again", async () => {
    const h = setup();
    const { order } = await quoted(h);
    const o = await h.engine.approve(order.id, wallet(() => {
      throw new WalletError("unknown", "timeout after submit");
    }));
    expect(o.state).toBe("outcome_unknown");
    expect(o.message).toMatch(/Don't pay again/);
    expect(stuckReason(o, o.updatedAt)).toMatch(/unknown/i);

    // Provider later confirms it received the payment.
    const done = await h.engine.poll(order.id);
    expect(done.state).toBe("outcome_unknown"); // 'pending' alone proves nothing
  });

  it("fails cleanly when the provider can't open the order, before the wallet is touched", async () => {
    const h = setup({ failOpen: true });
    const { order } = await quoted(h);
    const w = wallet();
    const o = await h.engine.approve(order.id, w);
    expect(o.state).toBe("failed");
    expect(w.steps).toHaveLength(0);
    expect(o.message).toMatch(/nothing was sent/);
  });

  it("records a provider failure with an order number to quote to support", async () => {
    const h = setup({ script: [{ status: "failed", message: "payout rejected" }] });
    const { order } = await quoted(h);
    await h.engine.approve(order.id, wallet());
    const o = await h.engine.poll(order.id);
    expect(o.state).toBe("failed");
    expect(o.message).toContain(order.id);
  });

  it("cancels only before approval", async () => {
    const h = setup();
    const { order } = await quoted(h);
    expect((await h.engine.cancel(order.id)).state).toBe("cancelled");
    const h2 = setup();
    const { order: o2 } = await quoted(h2);
    await h2.engine.approve(o2.id, wallet());
    expect((await h2.engine.cancel(o2.id)).state).toBe("processing");
  });
});

describe("state machine and stuck detection", () => {
  const base: Order = {
    id: "x",
    quote: { etaSeconds: 30 } as Order["quote"],
    state: "awaiting_approval",
    timeline: [{ at: 0, from: null, to: "awaiting_approval" }],
    stepRefs: [],
    createdAt: 0,
    updatedAt: 0,
    message: null,
  };
  it("rejects illegal transitions", () => {
    expect(() => transition(base, "completed", 1)).toThrow(/Illegal/);
    const done = transition(transition(transition(base, "submitting", 1), "processing", 2), "completed", 3);
    expect(() => transition(done, "processing", 4)).toThrow();
  });
  it("flags a processing order that outlives its ETA", () => {
    const o = transition(transition(base, "submitting", 1), "processing", 2);
    expect(stuckReason(o, 2 + 60_000)).toBeNull();
    expect(stuckReason(o, 2 + 30_000 * 3 + 61_000)).toMatch(/longer than quoted/);
  });
});
