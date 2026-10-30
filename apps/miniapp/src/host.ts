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
      /** Total NIM across every account Nimiq Pay shares; null while it is still connecting. */
      balanceNim: string | null;
      /** Each account and its NIM. Seen on a real device: the first account was empty and the second held the funds. */
      accounts: { address: string; nim: string }[];
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

  let addresses: string[] = [];
  try {
    addresses = await provider.listAccounts();
    const address = addresses[0];
    if (!address) return { status: "error", message: "No account found in Nimiq Pay. Create or import one, then reopen Errand." };
    const accounts: { address: string; nim: string }[] = [];
    let total = 0n;
    for (const a of addresses) {
      const luna = await provider.getBalance(a);
      total += BigInt(luna);
      accounts.push({ address: a, nim: lunaToNim(luna) });
    }
    return { status: "ready", network, language, fiat, address, balanceNim: lunaToNim(Number(total)), accounts };
  } catch (e) {
    // Seen on a real device: "Nimiq network is not ready" while Nimiq Pay is still connecting. Retry instead.
    if (addresses[0] && NimiqProviderError.is(e) && /not ready|consensus|connect/i.test(e.message)) {
      return { status: "ready", network, language, fiat, address: addresses[0], balanceNim: null, accounts: [] };
    }
    const message = NimiqProviderError.is(e) ? e.message : "Could not reach your wallet. Close and reopen Errand.";
    return { status: "error", message };
  }
}
