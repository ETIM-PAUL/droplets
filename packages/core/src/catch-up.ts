// The catch-up: for spending outside apps that save with Droplets, Droplets adds up the user's share of what they spent
// each day, week, two weeks or month, and offers to save it in one approval. Nothing can take it automatically:
// Nimiq Pay asks the user to approve every payment, including this one.

export type CatchUpEvery = "daily" | "weekly" | "biweekly" | "monthly";
export const CATCH_UP_EVERY: readonly CatchUpEvery[] = ["daily", "weekly", "biweekly", "monthly"];
export const isCatchUpEvery = (s: string): s is CatchUpEvery => (CATCH_UP_EVERY as readonly string[]).includes(s);

const DAY = 86_400_000;
/** Monday 5 January 2026: two-week periods start on it and on every second Monday from there. */
const BIWEEKLY_ANCHOR = Date.UTC(2026, 0, 5);
/** How far back from today one catch-up reaches, however long it's been left. */
export const CATCH_UP_MAX_DAYS = 62;

/** When the period containing `ms` began, in local time `offsetMinutes` east of UTC. Weeks start on Monday. */
export function catchUpPeriodStart(ms: number, every: CatchUpEvery, offsetMinutes: number): number {
  const off = offsetMinutes * 60_000;
  const day = Math.floor((ms + off) / DAY) * DAY; // local midnight, written as if it were UTC
  let start = day;
  if (every === "monthly") {
    const d = new Date(day);
    start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  } else if (every !== "daily") {
    const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
    const odd = (((Math.round((monday - BIWEEKLY_ANCHOR) / (7 * DAY)) % 2) + 2) % 2) === 1;
    start = every === "biweekly" && odd ? monday - 7 * DAY : monday;
  }
  return start - off;
}

/** When the period after the one containing `ms` begins. */
export function nextCatchUpPeriodStart(ms: number, every: CatchUpEvery, offsetMinutes: number): number {
  const start = catchUpPeriodStart(ms, every, offsetMinutes);
  // A moment inside the next period: no month is longer than 31 days.
  const step = { daily: 1, weekly: 7, biweekly: 14, monthly: 32 }[every] * DAY;
  return catchUpPeriodStart(start + step, every, offsetMinutes);
}

export interface CatchUpWindow {
  /** The spending a catch-up covers is in [from, to). */
  from: number;
  to: number;
  /** When the current period ends, and the next catch-up is ready. */
  next: number;
}

/**
 * What a catch-up covers right now: from `since` (the end of the last catch-up, or when the user turned saving
 * when paying on) to the most recent period boundary, reaching back at most CATCH_UP_MAX_DAYS from today. When
 * `to` isn't after `from`, the first period hasn't finished yet.
 */
export function catchUpWindow(now: number, every: CatchUpEvery, offsetMinutes: number, since: number): CatchUpWindow {
  const to = catchUpPeriodStart(now, every, offsetMinutes);
  return { from: Math.max(since, now - CATCH_UP_MAX_DAYS * DAY), to, next: nextCatchUpPeriodStart(now, every, offsetMinutes) };
}

/**
 * The user's share of what they spent, less what apps already saved when they paid them. Spending includes the part
 * paid on top to those apps, which was saved rather than spent, so the share is of spending without it. Never below 0.
 */
export function catchUpOwed(spent: bigint, spendPercent: number, alreadySaved: bigint): bigint {
  const spentOnThings = spent > alreadySaved ? spent - alreadySaved : 0n;
  const share = (spentOnThings * BigInt(spendPercent)) / 100n;
  return share > alreadySaved ? share - alreadySaved : 0n;
}
