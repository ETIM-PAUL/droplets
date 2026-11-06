import { getHostNetwork } from "@nimiq/mini-app-sdk";
import { createRailkitClient } from "@railkit/client";
import { sessionToken } from "./storage";

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
