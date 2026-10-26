import {
  getHostFiat,
  getHostLanguage,
  getHostNetwork,
  init,
  NimiqProviderError,
  type Network,
} from "@nimiq/mini-app-sdk";

const LUNA_PER_NIM = 100_000n;

export type HostState =
  | {
      status: "ready";
      network: Network;
      language: string;
      fiat: string;
      address: string;
      balanceNim: string;
    }
  | { status: "outside-nimiq-pay" }
  | { status: "error"; message: string };

export interface HostSdk {
  init: typeof init;
  getHostFiat: () => string | undefined;
  getHostLanguage: () => string | undefined;
  getHostNetwork: () => Network | undefined;
}

const defaultSdk: HostSdk = { init, getHostFiat, getHostLanguage, getHostNetwork };

/** Luna (integer) to a decimal NIM string; never goes through floats. */
export function lunaToNim(luna: number): string {
  const l = BigInt(luna);
  const whole = l / LUNA_PER_NIM;
  const frac = (l % LUNA_PER_NIM).toString().padStart(5, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export async function connectHost(sdk: HostSdk = defaultSdk): Promise<HostState> {
  // The host seeds these before page scripts run; absent outside Nimiq Pay.
  const network = sdk.getHostNetwork() ?? "mainnet";
  const language = sdk.getHostLanguage() ?? navigator.language.split("-")[0] ?? "en";
  const fiat = sdk.getHostFiat() ?? "USD";

  let provider;
  try {
    provider = await sdk.init({ timeout: 3_000 });
  } catch {
    return { status: "outside-nimiq-pay" };
  }

  try {
    const [address] = await provider.listAccounts();
    if (!address) return { status: "error", message: "No account found in Nimiq Pay. Create or import one, then reopen Errand." };
    const balanceNim = lunaToNim(await provider.getBalance(address));
    return { status: "ready", network, language, fiat, address, balanceNim };
  } catch (e) {
    const message = NimiqProviderError.is(e) ? e.message : "Could not reach your wallet. Close and reopen Errand.";
    return { status: "error", message };
  }
}
