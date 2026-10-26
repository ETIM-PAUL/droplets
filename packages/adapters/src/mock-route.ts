import {
  addMoney,
  ceilToDecimals,
  fromScaled,
  mulBpsCeil,
  msatToSats,
  toScaled,
  type PayIntent,
  type ProviderStatus,
  type Quote,
  type RouteAdapter,
} from "@railkit/core";

export interface MockRouteOptions {
  now?: () => number;
  /** Provider statuses returned by successive polls; the last one repeats. */
  script?: ProviderStatus[];
  feeBps?: number;
  quoteTtlMs?: number;
  etaSeconds?: number;
  failOpen?: boolean;
}

/** Pays BOLT11 invoices in a made-up world. Real adapters (Mavapay, Bitrefill, ...) share this interface. */
export function mockLightningRoute(o: MockRouteOptions = {}): RouteAdapter & { polls: number } {
  const now = o.now ?? Date.now;
  const script = o.script ?? [{ status: "pending" }, { status: "processing" }, { status: "completed" }];
  const state = { polls: 0 };

  return {
    id: "mock-lightning",
    get polls() {
      return state.polls;
    },

    canHandle: (i: PayIntent) => i.destination.kind === "bolt11" && i.destination.amountMsat !== null,

    async quote(i): Promise<Omit<Quote, "id" | "routeId" | "intent">> {
      const d = i.destination;
      if (d.kind !== "bolt11" || d.amountMsat === null) throw new Error("unsupported destination");
      const receive = { amount: msatToSats(d.amountMsat), currency: "SAT" };
      const fee = ceilToDecimals(mulBpsCeil(receive, o.feeBps ?? 100), 0);
      // Pretend 1 SAT costs 1 NIM-unit-of-account; the real rate comes from the provider.
      const send = addMoney(receive, fee);
      return {
        send,
        receive,
        fee,
        etaSeconds: o.etaSeconds ?? 30,
        expiresAt: now() + (o.quoteTtlMs ?? 60_000),
        steps: [{ kind: "pay-lightning-invoice", invoice: d.raw }],
        providerRef: null,
      };
    },

    async open() {
      if (o.failOpen) throw new Error("provider unavailable");
      return { providerRef: "mock-" + fromScaled(toScaled("1")) };
    },

    async poll() {
      const s = script[Math.min(state.polls, script.length - 1)]!;
      state.polls++;
      return s;
    },
  };
}
