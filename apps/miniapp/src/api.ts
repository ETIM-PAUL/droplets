import { getHostNetwork } from "@nimiq/mini-app-sdk";
import { createRailkitClient } from "@railkit/client";
import { demoApi, isDemo } from "./demo";
import { sessionToken } from "./storage";

export const SIGNED_OUT = "errand:signed-out";
const client = createRailkitClient({
  baseUrl: import.meta.env.VITE_RAILKIT_API_URL ?? "/api",
  token: () => sessionToken.get(),
  onUnauthorized: () => {
    sessionToken.clear();
    window.dispatchEvent(new Event(SIGNED_OUT));
  },
});
export const api = import.meta.env.DEV && isDemo() ? demoApi(client) : client;
export const hostNetwork = (): "mainnet" | "testnet" => (getHostNetwork() === "testnet" || (import.meta.env.DEV && isDemo()) ? "testnet" : "mainnet");
