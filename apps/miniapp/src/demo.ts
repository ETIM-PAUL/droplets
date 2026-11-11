// Development only: open the dev server with ?demo to see Droplets with made-up savings and no wallet, for design work
// and screenshots. ?demo=new shows someone who hasn't started saving; &tab=activity|draw|profile opens that tab.
// Production builds never include this: every use is behind import.meta.env.DEV.
import type { PrizeMe, RailkitClient, SaveActivity, SaveApp, SaveCatchUp, SaveGoals, SaveMe, SaveValidator } from "@railkit/client";

const query = () => new URLSearchParams(typeof location === "undefined" ? "" : location.search);
export const isDemo = (): boolean => import.meta.env.DEV && query().has("demo");
export const demoTab = (): string | null => (isDemo() ? query().get("tab") : null);
const fresh = () => query().get("demo") === "new";

export const DEMO_ADDRESS = "NQ25 P6YX JM69 LKAS K2DC EX64 H2V4 0FBY 4MSX";
const NIM = (n: number) => String(Math.round(n * 100_000));
const HOUR = 3_600_000;
const now = Date.now();
/** The demo week: Monday 9 to Sunday 15 November 2026, drawn at 23:59 in Lagos. */
const lagos = (d: number, h = 0, m = 0) => Date.UTC(2026, 10, d, h, m) - 60 * 60_000;

const apps: SaveApp[] = [
  { id: "a1", name: "Test Arcade" },
  { id: "a2", name: "NIMblers" },
  { id: "a3", name: "Quiz Night" },
];

function me(): SaveMe {
  if (fresh()) {
    return {
      network: "testnet", address: DEMO_ADDRESS, code: null, savePercent: null, spendPercent: null, catchUp: null, apps: [], blockNumber: 66_440_000,
      grow: null, growClosed: "no-stake", receipts: [], splits: [],
    };
  }
  return {
    network: "testnet", address: DEMO_ADDRESS, code: "SAVE-YEFMH3Q", savePercent: 30, spendPercent: 5, catchUp: "weekly", apps: apps.slice(0, 2),
    blockNumber: 66_440_000,
    grow: { active: NIM(3065), inactive: "0", inactiveFrom: null, retired: "0", delegation: "NQ26 0000 0000 02A5 YAK7 4QNF 9MH0 TE2B GVRU", releaseBlock: null, validatorJailed: false },
    growClosed: null,
    receipts: [
      { txHash: "a".repeat(64), app: "Test Arcade", kind: "grow", source: "spend", luna: NIM(5), at: now - 2 * HOUR },
      { txHash: "b".repeat(64), app: "Test Arcade", kind: "grow", source: "payout", luna: NIM(60), at: now - 5 * HOUR },
      { txHash: "c".repeat(64), app: "Test Arcade", kind: "wallet", source: "payout", luna: NIM(140), at: now - 5 * HOUR },
      { txHash: "d".repeat(64), app: "NIMblers", kind: "grow", source: "payout", luna: NIM(30), at: now - 26 * HOUR },
    ],
    splits: [],
  };
}

const activity = (): SaveActivity => ({
  payments: fresh() ? [] : [
    { payoutId: "s1", app: "Test Arcade", source: "spend", walletLuna: "0", growLuna: NIM(5), at: now - 2 * HOUR, reason: null },
    { payoutId: "p1", app: "Test Arcade", source: "payout", walletLuna: NIM(140), growLuna: NIM(60), at: now - 5 * HOUR, reason: null },
    { payoutId: "p2", app: "NIMblers", source: "payout", walletLuna: NIM(70), growLuna: NIM(30), at: now - 26 * HOUR, reason: null },
    { payoutId: "p3", app: "Quiz Night", source: "payout", walletLuna: NIM(25), growLuna: "0", at: now - 74 * HOUR, reason: "below-minimum" },
  ],
  grow: fresh() ? [] : [
    { txHash: "e".repeat(64), kind: "added", luna: NIM(100), at: now - 50 * HOUR, ok: true },
    { txHash: "f".repeat(64), kind: "opened", luna: NIM(2870), at: now - 6 * 24 * HOUR, ok: true },
  ],
});

const catchUp = (): SaveCatchUp => ({
  status: "due", every: "weekly", spendPercent: 5, from: lagos(2), to: lagos(9), next: lagos(16),
  spent: NIM(1200), alreadySaved: NIM(5), paid: "0", owed: NIM(54.75), complete: true, growOpen: true,
});

const prize = (): PrizeMe => ({
  rules: { minLuna: NIM(1000), daysNeeded: 5, prizeLuna: NIM(1000), maxTickets: 4, utcOffsetMinutes: 60, prizeAddress: null },
  joined: !fresh(),
  week: fresh() ? null : {
    week: "2026-11-09", drawAt: lagos(15, 23, 59), daysKept: 3, keptLuna: NIM(3065), tickets: 0, tooManyTransactions: false,
    days: [
      { day: "2026-11-09", status: "kept", lowLuna: NIM(3000) },
      { day: "2026-11-10", status: "kept", lowLuna: NIM(3065) },
      { day: "2026-11-11", status: "missed", lowLuna: NIM(800) },
      { day: "2026-11-12", status: "today", lowLuna: NIM(3065) },
      { day: "2026-11-13", status: "ahead", lowLuna: null },
      { day: "2026-11-14", status: "ahead", lowLuna: null },
      { day: "2026-11-15", status: "ahead", lowLuna: null },
    ],
  },
  lastDraw: {
    week: "2026-11-02", drawAt: lagos(8, 23, 59), blockNumber: 66_401_234, blockHash: "ab".repeat(32), entries: 12, totalTickets: 19, winningTicket: 7,
    winner: "NQ12 … AB34", youWon: false, prizeLuna: NIM(1000), paid: true, payoutTx: "9".repeat(64),
  },
  wins: [],
});

const goals = (): SaveGoals => {
  if (fresh()) return { totalLuna: "0", withdrawableLuna: "0", goals: [], bannedUntil: null };
  return {
    totalLuna: NIM(3065),
    withdrawableLuna: NIM(2065),
    goals: [
      { id: "g1", name: "Rent deposit", targetLuna: NIM(1_500), dueAt: null, allocatedLuna: NIM(1_000), done: false, locked: false, breaking: false, breakReadyAt: null, breached: false },
      { id: "g2", name: "December trip", targetLuna: NIM(2_000), dueAt: lagos(30), allocatedLuna: NIM(0), done: false, locked: true, breaking: false, breakReadyAt: null, breached: false },
    ],
    bannedUntil: null,
  };
};

const validators: SaveValidator[] = [
  { address: "NQ26 0000 0000 02A5 YAK7 4QNF 9MH0 TE2B GVRU", name: "Kalimba", stakeLuna: NIM(41_000_000), numStakers: 812 },
  { address: "NQ16 085S 7JNP YJNY UA5N G5Y5 B98N 0JT7 6GKB", name: "Moonpool", stakeLuna: NIM(28_500_000), numStakers: 455 },
  { address: "NQ61 1RMT GEPQ VA7A XDY3 NGQM 8ESG KR6B GH8M", name: null, stakeLuna: NIM(9_200_000), numStakers: 97 },
];

/** The real client, with everything the screens read answered from the made-up data above. */
export function demoApi(real: RailkitClient): RailkitClient {
  return {
    ...real,
    session: async () => ({ token: null, name: null }),
    saveMe: async () => me(),
    saveActivity: async () => activity(),
    saveCatchUp: async () => (fresh() ? { status: "off", every: null, spendPercent: 0 } : catchUp()),
    saveApps: async () => apps,
    saveValidators: async () => validators,
    prizeMe: async () => prize(),
    saveAsk: async () => ({ answer: "You have 3,065 NIM in savings, all of it earning staking rewards.", question: "balance", source: "rules" }),
    saveGoals: async () => goals(),
    saveGoalAction: async () => ({ ok: true as const }),
  };
}
