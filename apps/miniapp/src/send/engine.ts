import { getHostNetwork } from "@nimiq/mini-app-sdk";
import { bolt11Route, lnurlPayRoute, payoutRoute } from "@railkit/adapters";
import { createRailkitClient } from "@railkit/client";
import { Engine, type WalletExecutor } from "@railkit/core";
import { LocalOrderStore, sessionToken } from "../storage";

export const SIGNED_OUT = "errand:signed-out";
export const api = createRailkitClient({
  baseUrl: import.meta.env.VITE_RAILKIT_API_URL ?? "/api",
  token: () => sessionToken.get(),
  onUnauthorized: () => {
    sessionToken.clear();
    window.dispatchEvent(new Event(SIGNED_OUT));
  },
});
export const hostNetwork = (): "mainnet" | "testnet" => (getHostNetwork() === "testnet" ? "testnet" : "mainnet");
export const orderStore = new LocalOrderStore();

/** One engine per enabled-corridor set; the store is shared so orders survive the app closing. */
export function sendEngine(enabled: ReadonlySet<string>) {
  const network = hostNetwork();
  return new Engine({
    routes: [payoutRoute({ gateway: api.payouts, network, enabled }), bolt11Route({ network }), lnurlPayRoute({ network })],
    store: orderStore,
    network,
  });
}

/** Practice mode: payments are simulated on Mavapay staging and no real money moves. Set VITE_PRACTICE_MODE=true. */
export const PRACTICE = import.meta.env.VITE_PRACTICE_MODE === "true";

/** Stands in for Nimiq Pay in practice mode: "pays" by asking staging to simulate the payment for this order. */
export function practiceWallet(orderId: string): WalletExecutor {
  return {
    async execute() {
      await api.simulatePayment(orderId);
      return { ref: `practice:${orderId}` };
    },
  };
}
