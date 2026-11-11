// Puddle Quiz: a small app that pays NIM rewards, written the way a third-party app would use Droplets.
//
// Someone answers three questions and gets a reward. We pay the address they give (or a save code) through
// @droplets/save. If its owner allowed Puddle Quiz in Droplets, the reward splits between their wallet and their
// savings; otherwise it is one normal payment. Nothing here knows or cares which, apart from showing the result.
//
// This file is the whole backend. The payout key never leaves it: the page only ever sees amounts and hashes.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createNimiqRpc, createSaveApi, parseSaveCode, SaveApiError } from "@droplets/save";
import { createSavePayer, type PayoutLog, type PayoutRecord } from "@droplets/save/payer";
import * as Nimiq from "@nimiq/core";

const here = dirname(fileURLToPath(import.meta.url));
// Settings come from the environment, this folder's .env, or the repo's main .env. From the main one only names that
// start with PUDDLE_ are read, so nothing else in it (database, admin token, prize key) ever enters this process.
try {
  process.loadEnvFile(join(here, ".env"));
} catch {
  /* no .env file here */
}
const mainEnv: Record<string, string> = {};
try {
  for (const line of readFileSync(join(here, "../../.env"), "utf8").split("\n")) {
    const m = /^(PUDDLE_\w+)=(.*)$/.exec(line.trim());
    if (m?.[1] && m[2]) mainEnv[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* not inside the repo */
}
const setting = (name: string) => process.env[name] || process.env[`PUDDLE_${name}`] || mainEnv[`PUDDLE_${name}`] || "";

// ---------- Settings ----------
const NETWORK = setting("NETWORK") === "test" ? "test" : "main";
const APP_NAME = "Puddle Quiz";
const PORT = Number(setting("PORT") || 3000);
const DROPLETS_API_URL = setting("DROPLETS_API_URL") || "https://droplets-api.onrender.com";
const DROPLETS_KEY = setting("DROPLETS_KEY") || "";
const RPC_URL = setting("NIMIQ_RPC_URL") || (NETWORK === "main" ? "https://rpc.nimiqwatch.com" : "https://rpc.testnet.nimiqwatch.com");
/** Only people with a Droplets save code can play: a code exists only for someone who has set up Droplets. */
const REQUIRE_DROPLETS = setting("REQUIRE_DROPLETS") !== "no";
const LUNA_PER_NIM = 100_000n;
// Demo mode, for showing Droplets live: anyone can play again and again, with questions that may repeat. Every win still
// pays a real reward and the daily cap still applies. Leave it off for real use.
const DEMO_MODE = ["yes", "true", "1", "on"].includes(setting("DEMO_MODE").toLowerCase());
const REWARD = BigInt(Math.round(Number(setting("REWARD_NIM") || 5) * 100_000));
const DAILY_CAP = BigInt(Math.round(Number(setting("DAILY_CAP_NIM") || 50) * 100_000));
const DATA = setting("DATA_DIR") || join(here, ".data");
mkdirSync(DATA, { recursive: true, mode: 0o700 });

const nim = (l: bigint) => {
  const frac = (l % LUNA_PER_NIM).toString().padStart(5, "0").replace(/0+$/, "");
  return `${l / LUNA_PER_NIM}${frac ? `.${frac}` : ""}`;
};

// ---------- The payout wallet ----------
// The key comes from PAYOUT_KEY (for hosts without a disk) or from a file made on first run. It is never printed or sent.
function loadKey(): string {
  if (setting("PAYOUT_KEY")) return setting("PAYOUT_KEY").trim();
  const file = join(DATA, "wallet.key");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const fresh = Nimiq.PrivateKey.generate().toHex();
  writeFileSync(file, fresh + "\n", { mode: 0o600 });
  return fresh;
}
const keyPair = Nimiq.KeyPair.derive(Nimiq.PrivateKey.fromHex(loadKey()));
const WALLET = keyPair.toAddress().toUserFriendlyAddress();

const rpc = createNimiqRpc({ url: RPC_URL });
const api = DROPLETS_KEY ? createSaveApi({ apiUrl: DROPLETS_API_URL, apiKey: DROPLETS_KEY }) : undefined;
const payer = createSavePayer({
  api,
  rpc,
  nimiq: Nimiq,
  keyPair,
  network: NETWORK,
  log: fileLog(join(DATA, "payouts.json")),
});

// ---------- Remembering payouts ----------
// What was signed for each payout goes to disk before it is sent, so a retry resends the same transactions and never
// pays twice. A real app keeps this in its database; a file does the job for one process.
function fileLog(file: string): PayoutLog {
  const read = (): Record<string, PayoutRecord> =>
    existsSync(file) ? (JSON.parse(readFileSync(file, "utf8"), (_k, v) => (v && typeof v === "object" && "$big" in v ? BigInt(v.$big) : v)) as Record<string, PayoutRecord>) : {};
  const all = read();
  return {
    get: async (id) => all[id],
    put: async (r) => {
      all[r.payoutId] = r;
      writeFileSync(file, JSON.stringify(all, (_k, v) => (typeof v === "bigint" ? { $big: v.toString() } : v)), { mode: 0o600 });
    },
  };
}

interface Claim {
  luna: string;
  day: string;
  /** What the person was shown, kept so a repeat claim shows the same thing. */
  result?: Result;
}
const claimsFile = join(DATA, "claims.json");
const claims: Record<string, Claim> = existsSync(claimsFile) ? JSON.parse(readFileSync(claimsFile, "utf8")) : {};
const saveClaims = () => writeFileSync(claimsFile, JSON.stringify(claims), { mode: 0o600 });
const today = () => new Date().toISOString().slice(0, 10);
const paidToday = () => Object.values(claims).filter((c) => c.day === today()).reduce((n, c) => n + BigInt(c.luna), 0n);

// ---------- The quiz ----------
// A bank of questions. Each person gets three they haven't had before, so nobody sees a question twice. The answers
// stay here: the page is only sent the questions.
const BANK: { q: string; options: string[]; answer: number }[] = [
  { q: "What is the smallest unit of NIM called?", options: ["Satoshi", "Luna", "Gwei"], answer: 1 },
  { q: "How many luna make 1 NIM?", options: ["1,000", "100,000", "1,000,000"], answer: 1 },
  { q: "How much NIM does a staker need at least?", options: ["1 NIM", "10 NIM", "100 NIM"], answer: 2 },
  { q: "Nimiq addresses start with which letters?", options: ["NQ", "0x", "bc1"], answer: 0 },
  { q: "What kind of consensus does the Nimiq network use today?", options: ["Proof of work", "Proof of stake", "Proof of authority"], answer: 1 },
  { q: "Roughly how long can it take for NIM you unstake to come back to your wallet?", options: ["A few seconds", "12 to 24 hours", "A month"], answer: 1 },
  { q: "In Droplets, what is the name for the savings you keep in your own stake?", options: ["Grow", "Vault", "Pool"], answer: 0 },
  { q: "What is the smallest share of a payment you can choose to save in Droplets?", options: ["1%", "10%", "50%"], answer: 1 },
  { q: "How many NIM does the weekly Droplets draw give away?", options: ["10", "100", "1,000"], answer: 2 },
  { q: "How many NIM must you keep saved to enter the weekly Droplets draw?", options: ["10", "100", "1,000"], answer: 2 },
  { q: "Who sends your saved share into your stake when an app pays you through Droplets?", options: ["Droplets holds it for you", "The app, straight to your own stake", "Nimiq's validators"], answer: 1 },
  { q: "Which of these can Droplets do with your money?", options: ["Hold it for you", "Nothing: it only tells apps how to split payments", "Trade it for you"], answer: 1 },
  { q: "Droplets' tagline is \"Every payment leaves a ...\"?", options: ["Droplet", "Coin", "Receipt"], answer: 0 },
  { q: "What is the largest share of a payment you can save in Droplets?", options: ["50%", "90%", "100%"], answer: 2 },
  { q: "Who can move the NIM in your Droplets savings?", options: ["Only you", "Droplets and you", "The app that paid you"], answer: 0 },
  { q: "Does joining the weekly Droplets draw put your savings at risk?", options: ["Yes, you can lose them", "No, your savings stay yours", "Only if you don't win"], answer: 1 },
  { q: "Where does Droplets keep your savings?", options: ["In Droplets' wallet", "In a stake under your own Nimiq account", "In the app that paid you"], answer: 1 },
  { q: "What does \"spend and save\" in Droplets mean?", options: ["You save a share when you pay an app", "You borrow against savings", "You lock all your NIM"], answer: 0 },
  { q: "What is a Droplets goal?", options: ["A named slice of your savings, with an optional target and date", "A second wallet", "A loan limit"], answer: 0 },
  { q: "Which goals does Droplets lock until their date?", options: ["Every goal", "Goals that have a date", "Goals with no target"], answer: 1 },
  { q: "How much does it cost to break a dated Droplets goal early?", options: ["Nothing", "10% of what's in it", "50% of what's in it"], answer: 1 },
  { q: "After you ask to break a dated goal early, how long is the wait?", options: ["24 hours", "7 days", "30 days"], answer: 0 },
  { q: "What happens if you withdraw from a locked goal outside Droplets?", options: ["Nothing", "You can't create new goals for 30 days", "Your account is deleted"], answer: 1 },
  { q: "When money is saved, which Droplets goal does it fill first?", options: ["The first goal in the order you set", "The biggest goal", "A random goal"], answer: 0 },
  { q: "Can a Droplets goal have no date?", options: ["No, a date is required", "Yes, then you can close it any time", "Only for the first goal"], answer: 1 },
  { q: "If you leave the date of a goal blank, when can you close it?", options: ["Any time, or when the target is met", "Never", "Only after a year"], answer: 0 },
  { q: "By default, which apps may save from your payouts in Droplets?", options: ["None until you pick them", "Every app, including new ones", "Only the first three"], answer: 1 },
  { q: "What does a save code prove to an app?", options: ["That you have a Droplets account", "How much NIM you own", "Your name"], answer: 0 },
  { q: "What does an app need to do before it can use Droplets?", options: ["Register and be approved", "Hold 100,000 NIM", "Run a validator"], answer: 0 },
  { q: "What is \"catch-up\" in Droplets?", options: ["Saving a missed share, which you approve each time", "Free extra NIM", "A faster draw"], answer: 0 },
  { q: "How many NIM does a validator need as a deposit?", options: ["1,000", "10,000", "100,000"], answer: 2 },
  { q: "What is NIM's total supply?", options: ["21 million", "21 billion", "21 trillion"], answer: 1 },
  { q: "In which year did the Nimiq mainnet launch?", options: ["2014", "2018", "2022"], answer: 1 },
  { q: "What is Nimiq known for being able to run in?", options: ["A web browser", "A smart fridge", "Only data centers"], answer: 0 },
  { q: "What does a Nimiq validator do?", options: ["Produces and confirms blocks", "Mints new NIM for itself", "Holds users' savings"], answer: 0 },
  { q: "How are Nimiq addresses usually written?", options: ["Groups of four characters, like NQ30 KFJH ...", "One long number", "A word list"], answer: 0 },
  { q: "How many groups of four characters make up a Nimiq address?", options: ["6", "9", "12"], answer: 1 },
  { q: "What is Nimiq Pay?", options: ["A mobile wallet that runs Mini Apps", "A bank card", "A mining rig"], answer: 0 },
  { q: "What is a Mini App?", options: ["An app that runs inside Nimiq Pay", "A smaller NIM coin", "A staking pool"], answer: 0 },
  { q: "What do you earn by staking NIM?", options: ["Rewards", "Nothing, it's only a lock", "A new address"], answer: 0 },
  { q: "Why would a payment app use Droplets?", options: ["So its users can save part of what it pays them", "To hold users' funds", "To mine NIM"], answer: 0 },
  { q: "Can Droplets move your savings without you signing?", options: ["No, you approve every change", "Yes, whenever it likes", "Only on weekends"], answer: 0 },
];
const PASS = 2;
function shuffle(a: number[]): number[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
const PER_QUIZ = 3;

const seenFile = join(DATA, "seen.json");
const seen: Record<string, number[]> = existsSync(seenFile) ? JSON.parse(readFileSync(seenFile, "utf8")) : {};
const sessions = new Map<string, { to: string; id: string; picks: number[]; orders: number[][]; expires: number }>();

// ---------- Handling a claim ----------
interface Result {
  score: number;
  paid: boolean;
  message?: string;
  rewardNim?: string;
  walletNim?: string;
  growNim?: string;
  /** Why nothing went to savings when the person's rule asked for some. */
  reason?: string | null;
  walletTx?: string | null;
  growTx?: string | null;
  repeated?: boolean;
}
class Refusal extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Reads what a person typed: a save code or, when allowed, a Nimiq address in any spacing. */
function parseTarget(input: unknown): { to: string; id: string; code: boolean } {
  if (typeof input !== "string" || input.length > 80) throw new Refusal(REQUIRE_DROPLETS ? "Enter your Droplets save code." : "Enter a Nimiq address or a Droplets save code.");
  const code = parseSaveCode(input);
  if (code.ok) return { to: `SAVE-${code.value}`, id: `code-${code.value}`, code: true };
  if (REQUIRE_DROPLETS) throw new Refusal("That isn't a save code. Open Droplets, open your savings, copy your save code, and paste it here.");
  try {
    const address = Nimiq.Address.fromString(input.trim()).toUserFriendlyAddress();
    return { to: address, id: address.replace(/ /g, ""), code: false };
  } catch {
    throw new Refusal("That isn't a Nimiq address or a save code. Check it and try again.");
  }
}

/** The payout id: one per person per day, or in demo mode one per quiz so every win pays. */
const dayOf = (id: string, quizId = "") => `quiz-${createHash("sha256").update(DEMO_MODE ? `${id}|${quizId}` : id).digest("hex").slice(0, 24)}-${today()}`;

/** Checks the person is set up with Droplets, then deals three questions they haven't had. */
async function start(body: { to?: unknown }) {
  const target = parseTarget(body.to);
  const done = DEMO_MODE ? undefined : claims[dayOf(target.id)]?.result;
  if (done) return { done: { ...done, repeated: true } };
  if (target.code) {
    // A save code only exists for someone who has set up Droplets and opened Grow, and Droplets says 404 for any other.
    // So this is the check that only people with a Droplets account get as far as the quiz, let alone a payment.
    if (!api) throw new Refusal("This copy of Puddle Quiz isn't connected to Droplets yet.", 503);
    await api.split(target.to.slice(5), REWARD).catch((e: unknown) => {
      if (e instanceof SaveApiError && e.status === 404) throw new Refusal("Droplets doesn't know that save code. Check it, or make sure your savings are set up in Droplets.", 404);
      console.error("[start]", e);
      throw new Refusal("Couldn't reach Droplets just now. Try again in a minute.", 502);
    });
  }
  const had = new Set(DEMO_MODE ? [] : (seen[target.id] ?? []));
  const fresh = BANK.map((_, i) => i).filter((i) => !had.has(i));
  if (fresh.length < PER_QUIZ) throw new Refusal("You've answered every question we have. New ones are coming, so check back soon.", 410);
  const picks: number[] = [];
  while (picks.length < PER_QUIZ) picks.push(...fresh.splice(Math.floor(Math.random() * fresh.length), 1));
  if (!DEMO_MODE) {
    seen[target.id] = [...had, ...picks];
    writeFileSync(seenFile, JSON.stringify(seen), { mode: 0o600 });
  }
  // The options are shuffled for each quiz, so the right answer isn't always in the same place.
  const orders = picks.map(() => shuffle([0, 1, 2]));
  const quizId = randomUUID();
  for (const [k, s] of sessions) if (s.expires < Date.now()) sessions.delete(k);
  sessions.set(quizId, { to: target.to, id: target.id, picks, orders, expires: Date.now() + 20 * 60_000 });
  return { quizId, questions: picks.map((i, n) => ({ q: BANK[i]!.q, options: orders[n]!.map((o) => BANK[i]!.options[o]!) })) };
}

const busy = new Set<string>();
async function claim(body: { quizId?: unknown; answers?: unknown }): Promise<Result> {
  const session = typeof body.quizId === "string" ? sessions.get(body.quizId) : undefined;
  if (!session || session.expires < Date.now()) throw new Refusal("That quiz has timed out. Start again.", 410);
  const answers = Array.isArray(body.answers) ? body.answers : [];
  const score = session.picks.filter((q, i) => typeof answers[i] === "number" && session.orders[i]![answers[i]] === BANK[q]!.answer).length;
  const target = { to: session.to, id: session.id };
  if (score < PASS) {
    sessions.delete(body.quizId as string);
    return { score, paid: false, message: `${score} of ${PER_QUIZ} right. You need ${PASS} to win ${nim(REWARD)} NIM. Start again for three new questions.` };
  }

  // One reward per person per day. The payout id makes retries safe, and a repeat claim shows the first result.
  const payoutId = dayOf(target.id, body.quizId as string);
  const known = claims[payoutId];
  if (known?.result) return { ...known.result, repeated: true };
  if (busy.has(payoutId)) throw new Refusal("Your reward is being sent. Give it a moment.", 409);
  busy.add(payoutId);
  try {
    if (!known) {
      if (paidToday() + REWARD > DAILY_CAP) throw new Refusal("Today's rewards have run out. Come back tomorrow.", 503);
      if ((await rpc.balance(WALLET)) < REWARD) throw new Refusal("The prize wallet is empty right now. Please try again later.", 503);
      claims[payoutId] = { luna: REWARD.toString(), day: today() };
      saveClaims();
    }
    // The only Droplets-specific line: pay the code (or address) we were given. The SDK asks Droplets how to split it,
    // sends the wallet payment and the add-stake, and reports both back so they show in the person's savings history.
    const r = await payer.pay({ to: target.to, luna: REWARD, payoutId, memo: `${APP_NAME} reward` });
    const result: Result = {
      score,
      paid: true,
      rewardNim: nim(REWARD),
      walletNim: nim(r.walletLuna),
      growNim: nim(r.growLuna),
      reason: r.reason,
      walletTx: r.walletTx,
      growTx: r.growTx,
    };
    claims[payoutId] = { luna: REWARD.toString(), day: today(), result };
    saveClaims();
    sessions.delete(body.quizId as string);
    return result;
  } catch (e) {
    if (e instanceof Refusal) throw e;
    // The reservation and the quiz stay, so the person can press the button again and the payer resends the same transactions.
    console.error(`[claim ${payoutId}]`, e instanceof SaveApiError ? `Droplets said ${e.status}: ${e.message}` : e);
    throw new Refusal("Couldn't send the reward just now. Try again in a minute.", 502);
  } finally {
    busy.delete(payoutId);
  }
}

// ---------- The web server ----------
const hits = new Map<string, number[]>();
function limited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 10;
}

const FILES: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/client.js": ["client.js", "text/javascript; charset=utf-8"],
};
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};
const readBody = (req: IncomingMessage) =>
  new Promise<unknown>((resolve, reject) => {
    let raw = "";
    req.on("data", (c: Buffer) => {
      raw += c;
      if (raw.length > 4_000) reject(new Refusal("Too much data.", 413));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new Refusal("That request couldn't be read."));
      }
    });
  });

createServer(async (req, res) => {
  try {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method === "GET" && path === "/api/quiz") {
      return send(res, 200, {
        app: APP_NAME,
        network: NETWORK,
        rewardNim: nim(REWARD),
        pass: PASS,
        codeOnly: REQUIRE_DROPLETS,
        withDroplets: DROPLETS_KEY !== "",
      });
    }
    if (req.method === "POST" && path === "/api/start") {
      if (limited(req.socket.remoteAddress ?? "?")) throw new Refusal("Slow down a little and try again in a minute.", 429);
      return send(res, 200, await start((await readBody(req)) as { to?: unknown }));
    }
    if (req.method === "POST" && path === "/api/claim") {
      if (limited(req.socket.remoteAddress ?? "?")) throw new Refusal("Slow down a little and try again in a minute.", 429);
      return send(res, 200, await claim((await readBody(req)) as { quizId?: unknown; answers?: unknown }));
    }
    if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });
    const file = req.method === "GET" ? FILES[path] : undefined;
    if (file && existsSync(join(here, "public", file[0]))) {
      res.writeHead(200, { "Content-Type": file[1] });
      return res.end(readFileSync(join(here, "public", file[0])));
    }
    send(res, 404, { error: "Not found" });
  } catch (e) {
    if (e instanceof Refusal) return send(res, e.status, { error: e.message });
    const id = randomUUID().slice(0, 8);
    console.error(`[${id}]`, e);
    send(res, 500, { error: `Something went wrong (${id}).` });
  }
}).listen(PORT, async () => {
  const balance = await rpc.balance(WALLET).then(nim, () => "unknown");
  console.log(`${APP_NAME} is running on http://localhost:${PORT} (${NETWORK === "main" ? "mainnet" : "testnet"})`);
  console.log(`Payout wallet: ${WALLET}   balance: ${balance} NIM`);
  console.log(DROPLETS_KEY ? `Saving with Droplets at ${DROPLETS_API_URL}` : "DROPLETS_KEY isn't set: rewards are paid plainly, with no saving. See README.md.");
  await payer.checkNetwork().catch((e: Error) => console.error(`\n${e.message}`));
});
