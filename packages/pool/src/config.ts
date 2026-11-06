import { nimStringToLuna, parseNimiqAddress, parseUsd } from "@railkit/core";
import type { PoolConfig } from "./jobs";

type Env = Record<string, string | undefined>;

/**
 * The pool's settings from the environment, shared by the API and the worker so they never disagree.
 * Null when POOL_ENABLED isn't "true". Mainnet needs POOL_ALLOW_MAINNET=true as well: a deliberate second
 * switch, for after the legal review, so a copied testnet config can't open a pool with real money.
 */
export function poolConfigFromEnv(env: Env): PoolConfig | null {
  if (env.POOL_ENABLED !== "true") return null;
  const address = parseNimiqAddress(env.POOL_ADDRESS ?? "");
  if (!address.ok) throw new Error("POOL_ADDRESS must be the pool's Nimiq address");
  const network = env.POOL_NETWORK === "mainnet" ? "mainnet" : "testnet";
  if (network === "mainnet" && env.POOL_ALLOW_MAINNET !== "true") throw new Error("Steady and Boost on mainnet need POOL_ALLOW_MAINNET=true, after the legal review");
  const int = (k: string, d: number) => {
    const v = env[k];
    if (v === undefined || v === "") return d;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${k} must be a whole number`);
    return n;
  };
  const usd = (k: string, d: string) => {
    const v = env[k] ?? d;
    if (v === "" || v === "none") return undefined;
    const u = parseUsd(v);
    if (u === null) throw new Error(`${k} must be dollars, like 100 or 99.50`);
    return u;
  };
  const nimCap = (k: string, d: string) => {
    const v = env[k] ?? d;
    if (v === "" || v === "none") return undefined;
    const l = nimStringToLuna(v);
    if (!l.ok) throw new Error(`${k} must be NIM, like 2000000`);
    return l.value;
  };
  const every = int("POOL_SETTLE_EVERY_MINUTES", 1440);
  if (every < 5) throw new Error("POOL_SETTLE_EVERY_MINUTES must be at least 5");
  return {
    poolAddress: address.value,
    network,
    settleEveryMinutes: every,
    settleAtMinuteUtc: int("POOL_SETTLE_AT_MINUTE_UTC", 720),
    feeBpsPerYear: int("POOL_FEE_BPS_PER_YEAR", 100),
    caps: {
      maxSteadyUsdPerAddress: usd("POOL_MAX_STEADY_USD_PER_ADDRESS", "100"),
      maxSteadyUsdTotal: usd("POOL_MAX_STEADY_USD_TOTAL", "2000"),
      maxBoostLunaPerAddress: nimCap("POOL_MAX_BOOST_NIM_PER_ADDRESS", "2000000"),
    },
    minConfirmations: int("POOL_MIN_CONFIRMATIONS", 60),
    depositTtlMs: int("POOL_DEPOSIT_TTL_HOURS", 24) * 3600_000,
  };
}
