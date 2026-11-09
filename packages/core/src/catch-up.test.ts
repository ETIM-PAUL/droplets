import { describe, expect, it } from "vitest";
import { catchUpOwed, catchUpPeriodStart, catchUpWindow, nextCatchUpPeriodStart } from "./catch-up";
import type { NimiqTransaction } from "./nimiq-rpc";
import { ownHistory, spentBetween } from "./own-history";
import { stakeChanges } from "./prize";
import { growEvents, STAKING_CONTRACT } from "./save";
import { nimiqAddressBytes } from "./nimiq-address";

const NIM = (n: number) => BigInt(n) * 100_000n;
const WALLET = "NQ23 4CTV GPEU C004 7USS EPFM RQ5C METQ EMDP";
const HTLC1 = "NQ80 UUAS BU0Q 1111 1111 1111 1111 1111 1111";
const HTLC2 = "NQ89 4VDF DQ8Q 2222 2222 2222 2222 2222 2222";
const SWAP = "NQ89 V0MN CVGT 3333 3333 3333 3333 3333 3333";
const SHOP = "NQ09 XHGH TP20 4444 4444 4444 4444 4444 4444";
const PROVIDER = "NQ56 VE9K PV0Y 5555 5555 5555 5555 5555 5555";
const T = Date.UTC(2026, 10, 2, 9); // Monday 2 November 2026, 10:00 in Lagos
const H = 3_600_000;
const own = Buffer.from(nimiqAddressBytes(WALLET)).toString("hex");

let n = 0;
const tx = (from: string, to: string, nim: number, at: number, over: Partial<NimiqTransaction> = {}): NimiqTransaction => ({
  hash: (++n).toString(16).padStart(64, "0"), blockNumber: n, from, to, value: NIM(nim), recipientData: "", senderData: "", executionResult: true,
  confirmations: 1, timestamp: at, ...over,
});
const creates = { toType: 2, flags: 1 };

/** How Nimiq Pay moved one user's NIM on mainnet: wallet into an HTLC, payments out of it, the rest back, a new HTLC. */
function nimiqPayUser() {
  const chain: NimiqTransaction[] = [
    tx("NQ58 9P19 NENY 6666 6666 6666 6666 6666 6666", WALLET, 300, T),
    tx(WALLET, HTLC1, 300, T + H, creates),
    tx(HTLC1, SHOP, 100, T + 2 * H),
    tx(HTLC1, WALLET, 200, T + 30 * H), // the rest handed back before a top-up
    tx(WALLET, HTLC2, 600, T + 30 * H + 60_000, creates),
    tx(HTLC2, STAKING_CONTRACT, 100, T + 31 * H, { recipientData: `06${own}` }), // Grow, sent from the HTLC
    tx(HTLC2, STAKING_CONTRACT, 0, T + 32 * H, { recipientData: "080000000000989680", flags: 2 }), // set active to 100 NIM
    tx(HTLC2, SWAP, 82, T + 50 * H, creates), // a Lightning payment starts as an HTLC…
    tx(SWAP, PROVIDER, 82, T + 50 * H + 6_000), // …that the swap provider takes
    tx(HTLC2, SHOP, 5, T + 7 * 24 * H), // next week
  ];
  return (address: string) => Promise.resolve(chain.filter((t) => t.from === address || t.to === address).sort((a, b) => b.timestamp - a.timestamp));
}

describe("a Nimiq Pay user's own accounts", () => {
  it("finds the HTLCs the wallet funded, not the swaps they started, and reads each once", async () => {
    const reads: string[] = [];
    const read = nimiqPayUser();
    const h = await ownHistory(WALLET, (a) => (reads.push(a), read(a)), { since: T - 15 * 24 * H });
    expect(h.htlcs).toEqual([HTLC2, HTLC1]);
    expect(reads).toEqual([WALLET, HTLC2, HTLC1]);
    expect(new Set(h.txs.map((t) => t.hash)).size).toBe(h.txs.length);
    expect(h.complete).toBe(true);
  });

  it("counts what was spent, not moves between the user's accounts or saving", async () => {
    const h = await ownHistory(WALLET, nimiqPayUser(), { since: T - 15 * 24 * H });
    // First week: 100 NIM at the shop and an 82 NIM Lightning payment, counted as it leaves. Not the 300 into the HTLC, the 200 back, or Grow.
    expect(spentBetween(h, T, T + 7 * 24 * H)).toBe(NIM(182));
    expect(spentBetween(h, T + 7 * 24 * H, T + 14 * 24 * H)).toBe(NIM(5));
  });

  it("says when a history was cut short before the time it's needed from", async () => {
    const cut = async (a: string) => (await nimiqPayUser()(a)).slice(0, 2);
    expect((await ownHistory(WALLET, cut, { since: T - 15 * 24 * H, max: 2 })).complete).toBe(false);
    // Reads that reach back to when it's needed are enough, even short of when HTLCs are looked for from.
    expect((await ownHistory(WALLET, cut, { since: T - 15 * 24 * H, need: T + 50 * H, max: 2 })).complete).toBe(true);
  });

  it("shows a withdrawal paid back to the HTLC as well as to the wallet", async () => {
    const back = (to: string) => ({ ...tx(STAKING_CONTRACT, to, 60, T + 40 * H), senderData: "01" });
    expect(growEvents(WALLET, [back(HTLC2)], [WALLET, HTLC2]).map((e) => e.kind)).toEqual(["withdrawn"]);
    expect(growEvents(WALLET, [back(WALLET)]).map((e) => e.kind)).toEqual(["withdrawn"]);
  });

  it("sees staking that Nimiq Pay sent from the HTLC, for Grow's history and the draw", async () => {
    const h = await ownHistory(WALLET, nimiqPayUser(), { since: T - 15 * 24 * H });
    expect(growEvents(WALLET, h.txs).map((e) => e.kind)).toEqual([]); // the wallet alone sees none of it
    expect(growEvents(WALLET, h.txs, [WALLET, ...h.htlcs]).map((e) => e.kind)).toEqual(["withdrawal-started", "added"]);
    expect(stakeChanges(WALLET, h.txs, [WALLET, ...h.htlcs])).toEqual([
      { at: T + 32 * H, kind: "set", active: NIM(100) },
      { at: T + 31 * H, kind: "added", luna: NIM(100) },
    ]);
  });
});

describe("catch-up periods", () => {
  const WAT = 60;
  const lagos = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h) - WAT * 60_000;

  it("starts days at midnight, weeks on Monday, two-week periods every second Monday and months on the 1st, in local time", () => {
    const wed = lagos(2026, 11, 11, 15); // Wednesday 11 November, 15:00 in Lagos
    expect(catchUpPeriodStart(wed, "daily", WAT)).toBe(lagos(2026, 11, 11));
    expect(catchUpPeriodStart(wed, "weekly", WAT)).toBe(lagos(2026, 11, 9));
    expect(catchUpPeriodStart(wed, "monthly", WAT)).toBe(lagos(2026, 11, 1));
    // 5 January 2026 starts a two-week period, and so does 9 November, 44 weeks later. 16 November is its second week.
    expect(catchUpPeriodStart(wed, "biweekly", WAT)).toBe(lagos(2026, 11, 9));
    expect(catchUpPeriodStart(lagos(2026, 11, 16, 9), "biweekly", WAT)).toBe(lagos(2026, 11, 9));
    // 23:30 UTC on Sunday is already Monday in Lagos.
    expect(catchUpPeriodStart(Date.UTC(2026, 10, 8, 23, 30), "weekly", WAT)).toBe(lagos(2026, 11, 9));
  });

  it("knows when the next period starts, across month ends", () => {
    expect(nextCatchUpPeriodStart(lagos(2026, 11, 30, 23), "daily", WAT)).toBe(lagos(2026, 12, 1));
    expect(nextCatchUpPeriodStart(lagos(2026, 12, 31), "monthly", WAT)).toBe(lagos(2027, 1, 1));
    expect(nextCatchUpPeriodStart(lagos(2026, 2, 3), "monthly", WAT)).toBe(lagos(2026, 3, 1));
    expect(nextCatchUpPeriodStart(lagos(2026, 11, 11), "weekly", WAT)).toBe(lagos(2026, 11, 16));
    expect(nextCatchUpPeriodStart(lagos(2026, 11, 11), "biweekly", WAT)).toBe(lagos(2026, 11, 23));
  });

  it("covers from the last catch-up to the latest boundary, at most 62 days back", () => {
    const now = lagos(2026, 11, 11, 15);
    expect(catchUpWindow(now, "weekly", WAT, lagos(2026, 11, 1))).toEqual({ from: lagos(2026, 11, 1), to: lagos(2026, 11, 9), next: lagos(2026, 11, 16) });
    // Turned on this week: nothing has finished yet.
    const fresh = catchUpWindow(now, "weekly", WAT, lagos(2026, 11, 10));
    expect(fresh.to <= fresh.from).toBe(true);
    // 62 days back from now, not from the boundary: a month left unsaved can't reach further.
    expect(catchUpWindow(now, "daily", WAT, 0).from).toBe(now - 62 * 24 * H);
    expect(catchUpWindow(lagos(2026, 12, 31, 12), "monthly", WAT, 0).from).toBe(lagos(2026, 12, 31, 12) - 62 * 24 * H);
  });

  it("owes the share of spending less what apps already saved, never below 0", () => {
    expect(catchUpOwed(NIM(1200), 5, 0n)).toBe(NIM(60));
    // 1,200 spent includes 10 paid on top and saved: 5% of 1,190 is 59.5, less the 10 already saved.
    expect(catchUpOwed(NIM(1200), 5, NIM(10))).toBe(4_950_000n);
    // One purchase in an app that saves: 105 paid, 5 of it saved. Nothing more to catch up on.
    expect(catchUpOwed(NIM(105), 5, NIM(5))).toBe(0n);
    expect(catchUpOwed(NIM(100), 5, NIM(10))).toBe(0n);
    expect(catchUpOwed(NIM(100), 0, 0n)).toBe(0n);
  });
});
