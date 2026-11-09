// Pays the weekly draw's winners from the prize wallet, straight into their Grow. The prize wallet's key stays here,
// in .env.prize (gitignored): the API only says who won, keeps what this tool signs, and checks the payment on-chain.
//
//   pnpm pay-prizes            pays any unpaid prizes, then stops
//   pnpm pay-prizes --watch    keeps going, checking every 5 minutes
//
// On testnet the first run makes a prize wallet, fills it from the faucet and prints the address the API needs as
// PRIZE_ADDRESS. On mainnet, put the prize wallet's key in .env.prize as PRIZE_KEY=<64 hex characters> and fund it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createNimiqRpc, lunaToNimString } from "@railkit/core";
import { createSavePayer, type PayoutLog, type PayoutRecord } from "../src/payer";

const network = process.env.SAVE_NETWORK === "testnet" ? "testnet" : "mainnet";
const apiUrl = process.env.ERRAND_API_URL || `http://localhost:${process.env.PORT || 8787}`;
const admin = process.env.ADMIN_TOKEN;
if (!admin) throw new Error("Set ADMIN_TOKEN in .env: this tool asks the API who won with it.");
const rpc = createNimiqRpc({ url: process.env.NIMIQ_RPC_URL || (network === "testnet" ? "https://rpc.testnet.nimiqwatch.com" : "https://rpc.nimiqwatch.com") });
const Nimiq = await import("@nimiq/core");

// The prize wallet's key: from the environment, else .env.prize, which the first testnet run makes.
const file = new URL("../../../.env.prize", import.meta.url);
let key = process.env.PRIZE_KEY || (existsSync(file) ? /^PRIZE_KEY=([0-9a-f]{64})$/m.exec(readFileSync(file, "utf8"))?.[1] : undefined);
if (!key) {
  if (network !== "testnet") throw new Error("Put the prize wallet's key in .env.prize as PRIZE_KEY=<64 hex characters>. This tool only makes a wallet on testnet.");
  key = Nimiq.PrivateKey.generate().toHex();
  writeFileSync(file, `# The weekly draw's prize wallet, for pnpm pay-prizes. Testnet only. Never give this to the API or the Mini App.\nPRIZE_KEY=${key}\n`, { mode: 0o600 });
}
const keyPair = Nimiq.KeyPair.derive(Nimiq.PrivateKey.fromHex(key));
const wallet = keyPair.toAddress().toUserFriendlyAddress();
const nim = (luna: bigint) => `${lunaToNimString(luna)} NIM`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) };
  const r = await fetch(`${apiUrl}${path}`, init).catch(() => null);
  if (!r) throw new Error(`Couldn't reach the API at ${apiUrl}. Is it running?`);
  const out = (await r.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!r.ok || !out) throw new Error(out?.error?.message ?? `The API answered ${r.status}.`);
  return out;
}

// What the payer signed travels to the API as JSON, luna as strings, so a retry from anywhere resends it.
const encode = (r: PayoutRecord) => JSON.stringify(r, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
function decode(json: string): PayoutRecord {
  const r = JSON.parse(json) as Omit<PayoutRecord, "txs"> & { txs: (Omit<PayoutRecord["txs"][number], "luna"> & { luna: string })[] };
  return { ...r, txs: r.txs.map((t) => ({ ...t, luna: BigInt(t.luna) })) };
}

/** Makes sure the prize wallet holds `needed`: from the faucet on testnet; on mainnet it says what to send. */
async function funded(needed: bigint): Promise<boolean> {
  if ((await rpc.balance(wallet)) >= needed) return true;
  if (network !== "testnet") {
    console.log(`The prize wallet holds ${nim(await rpc.balance(wallet))} but needs ${nim(needed)}. Send NIM to ${wallet}.`);
    return false;
  }
  console.log(`Filling the prize wallet (${wallet}) from the testnet faucet…`);
  await fetch("https://faucet.pos.nimiq-testnet.com/tapit", { method: "POST", body: new URLSearchParams({ address: wallet }) }).catch(() => null);
  for (let i = 0; i < 30; i++) {
    if ((await rpc.balance(wallet)) >= needed) return true;
    await sleep(2_000);
  }
  console.log(`The faucet didn't fill ${wallet}. Send it some testnet NIM from Nimiq Pay, then try again.`);
  return false;
}

/** Pays every unpaid prize. Returns how many it paid. */
async function payAll(quiet: boolean): Promise<number> {
  const { prizeAddress, draws } = await call<{ prizeAddress: string | null; draws: { week: string; winner: string; prizeLuna: string; payout: string | null }[] }>("/v1/admin/prize/unpaid");
  if (prizeAddress !== wallet) {
    console.log(`The API checks payouts against PRIZE_ADDRESS=${prizeAddress ?? "(not set)"}, but this prize wallet is ${wallet}. Set PRIZE_ADDRESS=${wallet} in the API's settings and restart it.`);
    return 0;
  }
  if (draws.length === 0) {
    if (!quiet) console.log("No unpaid prizes.");
    return 0;
  }
  if (!(await funded(draws.reduce((n, d) => n + BigInt(d.prizeLuna), 0n)))) return 0;
  let paid = 0;
  for (const d of draws) {
    const log: PayoutLog = {
      get: async () => (d.payout ? decode(d.payout) : undefined),
      put: async (record) => void (await call("/v1/admin/prize/payout", { week: d.week, payout: encode(record) })),
    };
    const payer = createSavePayer({ rpc, nimiq: Nimiq, keyPair, network: network === "testnet" ? "test" : "main", log });
    // Into the winner's Grow while their stake can take it; to their wallet if their validator has gone.
    const staker = await rpc.staker(d.winner);
    const intoGrow = !!staker && !!(await rpc.validator(staker.delegation));
    try {
      const r = await payer.pay({ to: d.winner, luna: BigInt(d.prizeLuna), payoutId: `prize-${d.week}`, into: intoGrow ? "grow" : "wallet" });
      const txHash = (r.growTx ?? r.walletTx)!;
      for (let i = 0; i < 30; i++) {
        const s = await call<{ status: "paid" | "pending" }>("/v1/admin/prize/paid", { week: d.week, txHash });
        if (s.status === "paid") {
          console.log(`Paid the prize for the week of ${d.week}: ${nim(BigInt(d.prizeLuna))} ${intoGrow ? "into the winner's Grow" : "to the winner's wallet"}. Transaction ${txHash}.`);
          paid++;
          break;
        }
        await sleep(2_000);
      }
    } catch (e) {
      // Includes a payout that was signed but expired without landing: that needs a person to look before paying again.
      console.error(`Couldn't pay the prize for the week of ${d.week}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return paid;
}

console.log(`Prize wallet ${wallet} on ${network}: ${nim(await rpc.balance(wallet))}.`);
if (process.argv.includes("--watch")) {
  for (;;) {
    await payAll(true).catch((e) => console.error(e instanceof Error ? e.message : String(e)));
    await sleep(5 * 60_000);
  }
} else {
  await payAll(false);
}
