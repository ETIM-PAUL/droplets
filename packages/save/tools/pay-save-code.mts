// Testnet only. Plays an app that saves with Droplets, so you can watch a payment split between someone's wallet
// and their Grow. It pays through this package's SDK, the same way a real app would.
//
//   pnpm pay-save-code SAVE-7KQ2XMP 2000        pays a save code (from the repo root; NIM, 1000 if left out)
//   pnpm pay-save-code "NQ.. .." 2000            pays an address: split only if its owner allowed Test Arcade
//   pnpm pay-save-code --spend "NQ.. .." 100     spend and save: quotes a 100 NIM purchase, then saves the part on top
//
// For --spend, a real app would first take the quoted total from the user. This tool only plays the app, so it
// skips that payment and puts the saved part in from its own wallet.
//
// The first run gives the pretend app ("Test Arcade") a wallet, fills it from the testnet faucet, and
// registers it with your local API, which needs ADMIN_TOKEN in .env. The wallet key and the app key stay in
// .env.test-app (gitignored). Set ERRAND_API_URL to use an API somewhere other than localhost:PORT.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createNimiqRpc, lunaToNimString, nimStringToLuna } from "@railkit/core";
import { createSaveApi, SaveApiError } from "../src/index";
import { createSavePayer } from "../src/payer";

const args = process.argv.slice(2);
const spending = args[0] === "--spend";
const [code, amount = spending ? "100" : "1000"] = spending ? args.slice(1) : args;
if (!code) {
  console.error("Usage: pnpm pay-save-code <SAVE-XXXXXXX or Nimiq address> [NIM, default 1000]\n       pnpm pay-save-code --spend <Nimiq address> [price in NIM, default 100]");
  process.exit(1);
}
if (process.env.SAVE_NETWORK !== "testnet") throw new Error("This tool only runs on testnet: set SAVE_NETWORK=testnet in .env.");
const luna = nimStringToLuna(amount);
if (!luna.ok) throw new Error(luna.error.message);

const apiUrl = process.env.ERRAND_API_URL || `http://localhost:${process.env.PORT || 8787}`;
const rpc = createNimiqRpc({ url: process.env.NIMIQ_RPC_URL || "https://rpc.testnet.nimiqwatch.com" });
const Nimiq = await import("@nimiq/core");

const file = new URL("../../../.env.test-app", import.meta.url);
const saved: Record<string, string> = existsSync(file)
  ? Object.fromEntries(readFileSync(file, "utf8").split("\n").filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]))
  : {};
const key = saved.TEST_APP_KEY || Nimiq.PrivateKey.generate().toHex();
const keyPair = Nimiq.KeyPair.derive(Nimiq.PrivateKey.fromHex(key));
const address = keyPair.toAddress().toUserFriendlyAddress();
let apiKey = saved.TEST_APP_API_KEY || "";
const remember = () =>
  writeFileSync(file, `# Testnet only: the pretend app's wallet key and app key, for pnpm pay-save-code.\nTEST_APP_KEY=${key}\nTEST_APP_API_KEY=${apiKey}\n`, { mode: 0o600 });
remember();

async function register() {
  const admin = process.env.ADMIN_TOKEN;
  if (!admin) throw new Error("Set ADMIN_TOKEN in .env and restart the API, so this tool can register its test app.");
  const r = await fetch(`${apiUrl}/v1/admin/save/apps`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin}` },
    body: JSON.stringify({ name: "Test Arcade", payoutAddresses: [address] }),
  }).catch(() => null);
  if (!r?.ok) throw new Error(`Couldn't register the test app (${r?.status ?? "no answer"}). Is the API running at ${apiUrl}, started after ADMIN_TOKEN was set?`);
  apiKey = ((await r.json()) as { apiKey: string }).apiKey;
  remember();
}
if (!apiKey) await register();

// Testnet NIM from the faucet whenever the wallet can't cover the payment.
if ((await rpc.balance(address)) < luna.value) {
  console.log(`Filling Test Arcade's wallet (${address}) from the testnet faucet…`);
  await fetch("https://faucet.pos.nimiq-testnet.com/tapit", { method: "POST", body: new URLSearchParams({ address }) }).catch(() => null);
  for (let i = 0; i < 30 && (await rpc.balance(address)) < luna.value; i++) await new Promise((r) => setTimeout(r, 2_000));
  if ((await rpc.balance(address)) < luna.value) throw new Error(`The faucet didn't fill the wallet. Send ${address} some testnet NIM from Nimiq Pay, then try again.`);
}

const nim = (l: bigint) => `${lunaToNimString(l)} NIM`;
const payer = () => createSavePayer({ api: createSaveApi({ apiUrl, apiKey }), rpc, nimiq: Nimiq, keyPair, network: "test" });
const pay = async () => {
  if (!spending) return payer().pay({ to: code, luna: luna.value, payoutId: `test-${Date.now()}`, memo: "Test Arcade reward" });
  const quote = await createSaveApi({ apiUrl, apiKey }).spend(code, luna.value);
  if (quote.saveLuna === 0n) {
    console.log(`Nothing goes on top of a ${nim(luna.value)} purchase${quote.reason ? ` (${quote.reason})` : ": this address hasn't allowed Test Arcade, or saves 0% when paying"}.`);
    process.exit(0);
  }
  console.log(`Charge ${nim(quote.totalLuna)}: ${nim(quote.priceLuna)} for the purchase and ${nim(quote.saveLuna)} (${quote.spendPercent}%) for their savings.`);
  return payer().saveFromSpend({ to: code, luna: quote.saveLuna, payoutId: `test-spend-${Date.now()}` });
};
let r: Awaited<ReturnType<typeof pay>>;
try {
  r = await pay();
} catch (e) {
  // The local database was reset since the last run, so the app key is unknown: register again.
  if (!(e instanceof SaveApiError && e.status === 401)) throw e;
  await register();
  r = await pay();
}
if (spending) {
  console.log(r.growLuna > 0n ? `Test Arcade put ${nim(r.growLuna)} into their Grow.` : `Their Grow couldn't take it (${r.reason}), so Test Arcade sent ${nim(r.walletLuna)} back to their wallet.`);
  process.exit(0);
}
console.log(
  r.growLuna > 0n
    ? `Test Arcade paid ${code} ${nim(luna.value)}: ${nim(r.growLuna)} into Grow and ${nim(r.walletLuna)} to the wallet.`
    : `Test Arcade paid ${code} ${nim(luna.value)}, all to the wallet${r.reason ? ` (${r.reason})` : ""}.`,
);
