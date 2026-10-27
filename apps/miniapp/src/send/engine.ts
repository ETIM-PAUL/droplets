import { getHostNetwork } from "@nimiq/mini-app-sdk";
import { payoutRoute } from "@railkit/adapters";
import { createRailkitClient } from "@railkit/client";
import { Engine } from "@railkit/core";
import { LocalOrderStore } from "../storage";

export const api = createRailkitClient({ baseUrl: import.meta.env.VITE_RAILKIT_API_URL ?? "/api" });
export const hostNetwork = (): "mainnet" | "testnet" => (getHostNetwork() === "testnet" ? "testnet" : "mainnet");
export const orderStore = new LocalOrderStore();

/** One engine per enabled-corridor set; the store is shared so orders survive the app closing. */
export function sendEngine(enabled: ReadonlySet<string>) {
  const network = hostNetwork();
  return new Engine({ routes: [payoutRoute({ gateway: api.payouts, network, enabled })], store: orderStore, network });
}
