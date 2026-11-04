// The signing guard, run in CI: nothing reaches signing without Nimiq Pay's (or the wallet's) own dialog.
// Static rules over the source, so a change that breaks them fails the build instead of reaching users.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "dist") continue;
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\./.test(name)) files.push(p);
  }
}
for (const top of ["apps", "packages"]) for (const pkg of readdirSync(join(root, top))) {
  const src = join(root, top, pkg, "src");
  try { if (statSync(src).isDirectory()) walk(src); } catch { /* no src */ }
}

const problems = [];
const rel = (p) => relative(root, p);

// 1. No raw signing anywhere: only methods that make the wallet show its own approval dialog.
const FORBIDDEN = /\b(eth_sign|personal_sign|eth_signTypedData\w*|eth_signTransaction|signMessage|privateKey|mnemonic)\b/;
// Server-side provider credentials (API request signing, never wallet keys) may only live in these files.
const PROVIDER_KEY_FILES = new Set(["packages/adapters/src/changelly/api.ts", "apps/api/src/index.ts"]);
// 2. Only these files may create a wallet executor or saver (besides the wallet packages that define them).
const EXECUTOR_FILES = new Map([
  ["apps/miniapp/src/send/SendHome.tsx", ["send"]],
  ["apps/miniapp/src/send/Scan.tsx", ["pay"]],
  // Errand Save: each savings action is a tap handler that opens Nimiq Pay's own dialog.
  ["apps/miniapp/src/save/SaveHome.tsx", ["saveRule", "openGrow", "addToGrow", "startWithdrawal", "finishWithdrawal", "revokeCode"]],
  // The developer test page: only rendered when the test page is switched on (checked below).
  ["apps/miniapp/src/spike.tsx", null],
]);
// 3. Code that reads untrusted text (chat, QR, providers) or runs on the server must not touch the wallet.
const NO_WALLET = [/^packages\/(agent|adapters|core|client|save)\//, /^apps\/api\//, /^apps\/miniapp\/src\/send\/Chat\.tsx$/];
const WALLET_IMPORT = /from\s+["'](@railkit\/wallet-[\w-]+|@nimiq\/mini-app-sdk)["']/;
// 4. Wallet executors may only call methods that open the native dialog.
// sign and the staking calls open Nimiq Pay's confirmation too (checked in Nimiq Pay's useMiniAppHost.ts).
const ALLOWED_PROVIDER_CALLS = new Set([
  "payLightningInvoice", "sendBasicTransaction", "isConsensusEstablished", "request",
  "sign", "sendNewStakerTransaction", "sendStakeTransaction", "sendSetActiveStakeTransaction", "sendRetireStakeTransaction", "sendRemoveStakeTransaction",
]);
// 6. Server payouts (@railkit/save/payer) sign with the paying app's own key: only that file may hold a key pair,
//    and neither the phone nor the RailKit API may import it.
const KEYPAIR_FILES = new Set(["packages/save/src/payer.ts"]);
const NO_PAYER = [/^apps\/miniapp\//, /^packages\/client\//, /^apps\/api\//];
const ALLOWED_EVM_METHODS = new Set(["eth_chainId", "eth_requestAccounts", "eth_sendTransaction", "wallet_switchEthereumChain", "eth_accounts"]);

for (const f of files) {
  const r = rel(f);
  const src = readFileSync(f, "utf8");
  src.split("\n").forEach((line, i) => {
    const providerKey = PROVIDER_KEY_FILES.has(r) && /\bprivateKey\b/.test(line) && !/\b(eth_sign|personal_sign|signTypedData|signTransaction|signMessage|mnemonic)\b/.test(line);
    if (FORBIDDEN.test(line) && !providerKey && !/^\s*(\/\/|\*)/.test(line)) problems.push(`${r}:${i + 1} uses a raw signing or key API: ${line.trim()}`);
  });

  // Server-only adapters hold provider keys: browser code may import their types, never their code.
  if (/^(apps\/miniapp|packages\/client)\//.test(r)) {
    for (const m of src.matchAll(/^import\s+(type\s+)?[^;]*from\s+["']@railkit\/adapters\/server["']/gm)) {
      if (!m[1]) problems.push(`${r} imports server-only adapter code; use "import type" so no keys or signing code reach the phone`);
    }
  }

  if (NO_WALLET.some((re) => re.test(r)) && WALLET_IMPORT.test(src)) problems.push(`${r} imports a wallet package; untrusted-input and server code must never reach signing`);

  if (!KEYPAIR_FILES.has(r)) src.split("\n").forEach((line, i) => {
    if (/\bkeyPair\b/.test(line) && !/^\s*(\/\/|\*)/.test(line)) problems.push(`${r}:${i + 1} holds a key pair; only ${[...KEYPAIR_FILES].join(", ")} (server payouts) may`);
  });
  if (NO_PAYER.some((re) => re.test(r)) && /from\s+["']@railkit\/save\/payer["']/.test(src)) problems.push(`${r} imports @railkit/save/payer, which signs server payouts; the phone and the RailKit API must never reach it`);

  for (const m of src.matchAll(/\bcreate(Nimiq|Evm)(Executor|Saver)\(/g)) {
    if (/^packages\/wallet-(nimiq|evm)\//.test(r)) continue;
    if (!EXECUTOR_FILES.has(r)) {
      problems.push(`${r} creates a wallet executor or saver; only ${[...EXECUTOR_FILES.keys()].join(", ")} may`);
      continue;
    }
    const allowedFns = EXECUTOR_FILES.get(r);
    if (!allowedFns) continue;
    // The enclosing function must be the button handler the user taps.
    const before = src.slice(0, m.index);
    const fn = [...before.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g)].at(-1)?.[1];
    if (!allowedFns.includes(fn)) problems.push(`${r} creates a wallet executor or saver inside ${fn ?? "top-level code"}; only ${allowedFns.join("/")} (a tap handler) may`);
  }

  if (/^packages\/wallet-(nimiq|evm)\/src\/[^/]+\.ts$/.test(r)) {
    for (const m of src.matchAll(/provider\.(\w+)\(/g)) if (!ALLOWED_PROVIDER_CALLS.has(m[1])) problems.push(`${r} calls provider.${m[1]}, which isn't on the native-dialog list`);
    for (const m of src.matchAll(/method:\s*"(\w+)"/g)) if (!ALLOWED_EVM_METHODS.has(m[1])) problems.push(`${r} sends ${m[1]}, which isn't on the native-dialog list`);
  }
}

// 5. The developer test page can pay too, so it must not be reachable in a normal build.
const main = readFileSync(join(root, "apps/miniapp/src/main.tsx"), "utf8");
if (!/TEST_PAGE\s*&&\s*hash === "#spike"/.test(main)) problems.push("apps/miniapp/src/main.tsx must only render the test page when TEST_PAGE is on");

if (problems.length) {
  console.error(`Signing guard: ${problems.length} problem(s)\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`Signing guard: ${files.length} files checked, nothing reaches signing without the native dialog.`);
