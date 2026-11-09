// Droplets's weekly draw. Keep at least the minimum in Grow on enough days of the week and you're in the
// Sunday draw; keep more and you hold more tickets, up to MAX_TICKETS. Pure functions, shared by the API (which
// reads stakes and runs the draw) and the Mini App (which shows the week).
import { nimiqAddressBytes, parseNimiqAddress, addressKey, sameAddress } from "./nimiq-address";
import type { NimiqTransaction } from "./nimiq-rpc";
import { fail, ok, type Result } from "./result";
import { STAKING_CONTRACT } from "./save";

export interface PrizeRules {
  /** Luna that has to stay in Grow, as active stake, for a whole day to count. */
  minLuna: bigint;
  /** How many of the week's 7 days have to count. */
  daysNeeded: number;
  /** What the winner gets, in luna. */
  prizeLuna: bigint;
  /** Minutes ahead of UTC for the days and the Sunday 23:59 draw. 60 is West Africa Time. */
  utcOffsetMinutes: number;
}

/** Keeping more earns more tickets, but never more than this: the biggest savers mustn't win every week. */
export const MAX_TICKETS = 4;

/** One ticket at the minimum, and one more for each 10 times as much: 1,000 NIM is 1, 10,000 is 2, and so on. */
export function ticketsFor(keptLuna: bigint, minLuna: bigint): number {
  if (minLuna <= 0n) throw new RangeError("The minimum must be above 0.");
  if (keptLuna < minLuna) return 0;
  let tickets = 1;
  for (let next = minLuna * 10n; tickets < MAX_TICKETS && keptLuna >= next; next *= 10n) tickets++;
  return tickets;
}

// ---- Weeks run Monday to Sunday in the draw's time zone. The draw is Sunday at 23:59.

const DAY_MS = 86_400_000;
const DRAW_MINUTE = 23 * 60 + 59;

export interface PrizeWeek {
  /** The week's Monday, e.g. "2026-11-09". It names the week. */
  week: string;
  /** Monday to Sunday, with when each starts and ends (ms since 1970). Sunday ends at the draw. */
  days: { day: string; start: number; end: number }[];
  /** Sunday 23:59 local, in ms since 1970. */
  drawAt: number;
}

const dayName = (d: number) => new Date(d * DAY_MS).toISOString().slice(0, 10);

function weekFromMonday(monday: number, utcOffsetMinutes: number): PrizeWeek {
  const shift = utcOffsetMinutes * 60_000;
  const drawAt = (monday + 6) * DAY_MS + DRAW_MINUTE * 60_000 - shift;
  const days = Array.from({ length: 7 }, (_, i) => ({
    day: dayName(monday + i),
    start: (monday + i) * DAY_MS - shift,
    end: Math.min((monday + i + 1) * DAY_MS - shift, drawAt),
  }));
  return { week: dayName(monday), days, drawAt };
}

/** The week a moment falls in. */
export function prizeWeekAt(ms: number, utcOffsetMinutes: number): PrizeWeek {
  const day = Math.floor((ms + utcOffsetMinutes * 60_000) / DAY_MS);
  // 1 January 1970 was a Thursday, 3 days after a Monday.
  return weekFromMonday(day - ((day + 3) % 7), utcOffsetMinutes);
}

/** A week by its Monday, e.g. "2026-11-09". Null for anything that isn't a Monday's date. */
export function prizeWeek(week: string, utcOffsetMinutes: number): PrizeWeek | null {
  const t = /^\d{4}-\d\d-\d\d$/.test(week) ? Date.parse(`${week}T00:00:00Z`) : NaN;
  if (Number.isNaN(t)) return null;
  const day = t / DAY_MS;
  return (day + 3) % 7 === 0 ? weekFromMonday(day, utcOffsetMinutes) : null;
}

/** The week before. */
export const previousWeek = (w: PrizeWeek, utcOffsetMinutes: number): PrizeWeek => prizeWeekAt(w.days[0]!.start - 1, utcOffsetMinutes);

// ---- What a person kept in Grow each day, from their own transactions and the times we looked.

/** Something known about a person's active stake at a moment. */
export type StakePoint =
  /** Read from the chain: exactly this much. */
  | { at: number; kind: "seen"; active: bigint }
  /** Their own transaction set it exactly: opening Grow, or setting a new active amount to start a withdrawal. */
  | { at: number; kind: "set"; active: bigint }
  /** Their own add-stake: this much more. */
  | { at: number; kind: "added"; luna: bigint };


/**
 * Staking changes in a person's own transactions. Only the owner can lower their active stake, and only with a
 * set-active-stake (08, then the new active balance as 8 bytes big-endian), so no drop is ever missed. Add-stakes
 * that others pay in aren't in the person's history; they only ever raise the stake, so leaving them out errs low.
 */
export function stakeChanges(address: string, txs: NimiqTransaction[], accounts: Iterable<string> = [address]): StakePoint[] {
  const own = Array.from(nimiqAddressBytes(address), (b) => b.toString(16).padStart(2, "0")).join("");
  // Nimiq Pay sends the user's staking transactions from their HTLC, not their wallet address: count all their accounts.
  const mine = new Set([...accounts].map(addressKey));
  const out: StakePoint[] = [];
  for (const t of txs) {
    if (!t.executionResult || !mine.has(addressKey(t.from)) || !sameAddress(t.to, STAKING_CONTRACT)) continue;
    const data = t.recipientData.toLowerCase();
    if (data.startsWith("05")) out.push({ at: t.timestamp, kind: "set", active: t.value });
    else if (data.startsWith("06") && data.slice(2, 42) === own) out.push({ at: t.timestamp, kind: "added", luna: t.value });
    else if (data.startsWith("08") && /^[0-9a-f]{16}$/.test(data.slice(2, 18))) out.push({ at: t.timestamp, kind: "set", active: BigInt(`0x${data.slice(2, 18)}`) });
  }
  return out;
}

/**
 * The least each day's active stake could have been, in day order; null for a day we know nothing about yet
 * (before the first time we looked). Between the points we know, the stake can only have gone up, because only
 * the owner can lower it and their changes are all points. So these lows are never higher than the truth.
 */
export function dailyLows(points: StakePoint[], days: { start: number; end: number }[]): (bigint | null)[] {
  // At the same moment, apply the person's own changes before a reading: the reading is the later fact.
  const order = { set: 0, added: 1, seen: 2 } as const;
  const sorted = [...points].sort((a, b) => a.at - b.at || order[a.kind] - order[b.kind]);
  let known: bigint | null = null;
  let i = 0;
  const apply = (p: StakePoint) => {
    if (p.kind === "added") {
      if (known !== null) known += p.luna;
    } else known = p.active;
  };
  return days.map(({ start, end }) => {
    while (i < sorted.length && sorted[i]!.at < start) apply(sorted[i++]!);
    let low: bigint | null = known;
    while (i < sorted.length && sorted[i]!.at < end) {
      apply(sorted[i++]!);
      if (known !== null && (low === null || known < low)) low = known;
    }
    return low;
  });
}

export interface WeekScore {
  /** Days the stake never went under the minimum. */
  daysKept: number;
  /** The most kept on enough days: the daysNeeded-th highest daily low. 0 when there aren't enough days. */
  keptLuna: bigint;
  tickets: number;
}

/** Whether a week's lows earn a place in the draw, and how many tickets. */
export function scoreWeek(lows: (bigint | null)[], rules: Pick<PrizeRules, "minLuna" | "daysNeeded">): WeekScore {
  const kept = lows.filter((l): l is bigint => l !== null && l >= rules.minLuna).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  if (kept.length < rules.daysNeeded) return { daysKept: kept.length, keptLuna: 0n, tickets: 0 };
  // The daysNeeded-th highest: topping up for a day or two doesn't buy a higher tier.
  const keptLuna = kept[rules.daysNeeded - 1]!;
  return { daysKept: kept.length, keptLuna, tickets: ticketsFor(keptLuna, rules.minLuna) };
}

// ---- The draw.

export interface PrizeEntry {
  address: string;
  tickets: number;
}

/**
 * Picks the winning ticket with a block hash nobody could know beforehand: the first block made after the draw
 * time. Entries go in address order, tickets are numbered from 0, and the winner holds ticket (hash mod total).
 * Anyone with the entries and the block can work it out again.
 */
export function pickWinner(entries: PrizeEntry[], blockHash: string): { address: string; ticket: number; totalTickets: number } | null {
  if (!/^[0-9a-f]{64}$/i.test(blockHash)) throw new RangeError("A block hash is 32 bytes of hex.");
  const sorted = entries.filter((e) => e.tickets > 0).sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  const totalTickets = sorted.reduce((n, e) => n + e.tickets, 0);
  if (totalTickets === 0) return null;
  const ticket = Number(BigInt(`0x${blockHash}`) % BigInt(totalTickets));
  let left = ticket;
  for (const e of sorted) {
    if (left < e.tickets) return { address: e.address, ticket, totalTickets };
    left -= e.tickets;
  }
  throw new Error("The winning ticket is past the last entry.");
}

// ---- Joining and leaving, signed by the person in Nimiq Pay.

export interface DrawMessage {
  action: "join" | "leave";
  address: string;
  /** ISO 8601 UTC. */
  time: string;
  /** 16 to 64 hex characters, never reused. */
  nonce: string;
}

const DRAW_TITLE = "Errand weekly draw";

/** The exact text the person signs. */
export function formatDrawMessage(m: DrawMessage): string {
  return [DRAW_TITLE, `Action: ${m.action}`, `Address: ${m.address}`, `Time: ${m.time}`, `Nonce: ${m.nonce}`].join("\n");
}

/** Reads a signed join or leave. Anything but the exact format formatDrawMessage writes is refused. */
export function parseDrawMessage(text: string): Result<DrawMessage> {
  const bad = fail("unrecognised", "That isn't a Droplets draw message.");
  const lines = text.split("\n");
  const field = (i: number, name: string) => (lines[i]?.startsWith(`${name}: `) ? lines[i]!.slice(name.length + 2) : null);
  const action = field(1, "Action");
  const address = parseNimiqAddress(field(2, "Address") ?? "");
  const time = field(3, "Time") ?? "";
  const nonce = field(4, "Nonce") ?? "";
  if (lines[0] !== DRAW_TITLE || lines.length !== 5 || (action !== "join" && action !== "leave") || !address.ok) return bad;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/.test(time) || Number.isNaN(Date.parse(time)) || !/^[0-9a-f]{16,64}$/.test(nonce)) return bad;
  const m: DrawMessage = { action, address: address.value, time, nonce };
  return formatDrawMessage(m) === text ? ok(m) : bad;
}
