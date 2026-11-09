import type { Pool } from "pg";

/** Someone in the weekly draw. One entry per address, and one per phone. */
export interface PrizeEntryRow {
  address: string;
  /** Nimiq Pay's identifier for the phone, so one phone can't enter several accounts. */
  device: string;
  joinedAt: number;
  /** When their stake was last read from the chain; null before the first read. */
  checkedAt: number | null;
}

/** A time someone's active stake was read from the chain. */
export interface PrizeCheckRow {
  address: string;
  at: number;
  activeLuna: string;
}

export interface PrizeDrawEntry {
  address: string;
  tickets: number;
  daysKept: number;
  keptLuna: string;
}

/** One week's draw. Kept for the record, with every entry, so it can be worked out again. */
export interface PrizeDrawRow {
  /** The week's Monday, e.g. "2026-11-09". */
  week: string;
  drawAt: number;
  /** The first block made at or after the draw time: its hash picked the winning ticket. */
  blockNumber: number;
  blockHash: string;
  /** Everyone who qualified, with their tickets. */
  entries: PrizeDrawEntry[];
  totalTickets: number;
  winningTicket: number | null;
  winner: string | null;
  prizeLuna: string;
  status: "no-entries" | "unpaid" | "paid";
  /** What the payout tool signed (JSON), so a retry resends that same transaction. */
  payout: string | null;
  payoutTx: string | null;
  paidAt: number | null;
  createdAt: number;
}

export interface PrizeStore {
  /** True the first time a nonce is seen, false after; old nonces are forgotten after a day. */
  useNonce(nonce: string, at: number): Promise<boolean>;
  entry(address: string): Promise<PrizeEntryRow | undefined>;
  entryByDevice(device: string): Promise<PrizeEntryRow | undefined>;
  /** Adds the address's entry, or replaces it (a new phone). */
  join(row: PrizeEntryRow): Promise<void>;
  leave(address: string): Promise<void>;
  entries(): Promise<PrizeEntryRow[]>;
  /** Entries whose stake was last read before `before` (never-read first), at most `limit`. */
  due(before: number, limit: number): Promise<PrizeEntryRow[]>;
  /** Records a reading, and when the entry was last read. */
  addCheck(row: PrizeCheckRow): Promise<void>;
  /** Readings from `since` on, oldest first, led by the last reading before it: what was known when the period began. */
  checks(address: string, since: number): Promise<PrizeCheckRow[]>;
  pruneChecks(before: number): Promise<void>;
  draw(week: string): Promise<PrizeDrawRow | undefined>;
  /** False when that week already has a draw. */
  addDraw(row: PrizeDrawRow): Promise<boolean>;
  /** Newest first. */
  draws(limit: number): Promise<PrizeDrawRow[]>;
  wins(address: string): Promise<PrizeDrawRow[]>;
  unpaid(): Promise<PrizeDrawRow[]>;
  setPayout(week: string, payout: string): Promise<void>;
  markPaid(week: string, txHash: string, at: number): Promise<void>;
}

const NONCE_TTL_MS = 86_400_000;

export class MemoryPrizeStore implements PrizeStore {
  private nonces = new Map<string, number>();
  private entryRows = new Map<string, PrizeEntryRow>();
  private checkRows: PrizeCheckRow[] = [];
  private drawRows = new Map<string, PrizeDrawRow>();

  async useNonce(nonce: string, at: number) {
    for (const [n, t] of this.nonces) if (at - t > NONCE_TTL_MS) this.nonces.delete(n);
    if (this.nonces.has(nonce)) return false;
    this.nonces.set(nonce, at);
    return true;
  }
  async entry(address: string) {
    return this.entryRows.get(address);
  }
  async entryByDevice(device: string) {
    return [...this.entryRows.values()].find((e) => e.device === device);
  }
  async join(row: PrizeEntryRow) {
    this.entryRows.set(row.address, { ...row });
  }
  async leave(address: string) {
    this.entryRows.delete(address);
  }
  async entries() {
    return [...this.entryRows.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  }
  async due(before: number, limit: number) {
    return [...this.entryRows.values()].filter((e) => (e.checkedAt ?? 0) < before).sort((a, b) => (a.checkedAt ?? 0) - (b.checkedAt ?? 0)).slice(0, limit);
  }
  async addCheck(row: PrizeCheckRow) {
    this.checkRows.push({ ...row });
    const e = this.entryRows.get(row.address);
    if (e) this.entryRows.set(row.address, { ...e, checkedAt: Math.max(e.checkedAt ?? 0, row.at) });
  }
  async checks(address: string, since: number) {
    const mine = this.checkRows.filter((c) => c.address === address).sort((a, b) => a.at - b.at);
    const before = mine.filter((c) => c.at < since).at(-1);
    return [...(before ? [before] : []), ...mine.filter((c) => c.at >= since)];
  }
  async pruneChecks(before: number) {
    this.checkRows = this.checkRows.filter((c) => c.at >= before);
  }
  async draw(week: string) {
    return this.drawRows.get(week);
  }
  async addDraw(row: PrizeDrawRow) {
    if (this.drawRows.has(row.week)) return false;
    this.drawRows.set(row.week, { ...row });
    return true;
  }
  async draws(limit: number) {
    return [...this.drawRows.values()].sort((a, b) => b.drawAt - a.drawAt).slice(0, limit);
  }
  async wins(address: string) {
    return [...this.drawRows.values()].filter((d) => d.winner === address).sort((a, b) => b.drawAt - a.drawAt);
  }
  async unpaid() {
    return [...this.drawRows.values()].filter((d) => d.status === "unpaid").sort((a, b) => a.drawAt - b.drawAt);
  }
  async setPayout(week: string, payout: string) {
    const d = this.drawRows.get(week);
    if (d && d.status === "unpaid") this.drawRows.set(week, { ...d, payout });
  }
  async markPaid(week: string, txHash: string, at: number) {
    const d = this.drawRows.get(week);
    if (d && d.status === "unpaid") this.drawRows.set(week, { ...d, status: "paid", payoutTx: txHash, paidAt: at });
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS prize_nonces (
  nonce TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS prize_entries (
  address TEXT PRIMARY KEY,
  device TEXT NOT NULL UNIQUE,
  joined_at BIGINT NOT NULL,
  checked_at BIGINT
);
CREATE TABLE IF NOT EXISTS prize_checks (
  address TEXT NOT NULL,
  at BIGINT NOT NULL,
  active_luna TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS prize_checks_address ON prize_checks (address, at);
CREATE TABLE IF NOT EXISTS prize_draws (
  week TEXT PRIMARY KEY,
  draw_at BIGINT NOT NULL,
  block_number BIGINT NOT NULL,
  block_hash TEXT NOT NULL,
  entries TEXT NOT NULL,
  total_tickets INTEGER NOT NULL,
  winning_ticket INTEGER,
  winner TEXT,
  prize_luna TEXT NOT NULL,
  status TEXT NOT NULL,
  payout TEXT,
  payout_tx TEXT,
  paid_at BIGINT,
  created_at BIGINT NOT NULL
);`;

type Num = string | number;
interface EntryRow { address: string; device: string; joined_at: Num; checked_at: Num | null }
interface CheckRow { address: string; at: Num; active_luna: string }
interface DrawRow {
  week: string; draw_at: Num; block_number: Num; block_hash: string; entries: string; total_tickets: Num; winning_ticket: Num | null; winner: string | null;
  prize_luna: string; status: PrizeDrawRow["status"]; payout: string | null; payout_tx: string | null; paid_at: Num | null; created_at: Num;
}

const entry = (r: EntryRow): PrizeEntryRow => ({ address: r.address, device: r.device, joinedAt: Number(r.joined_at), checkedAt: r.checked_at === null ? null : Number(r.checked_at) });
const check = (r: CheckRow): PrizeCheckRow => ({ address: r.address, at: Number(r.at), activeLuna: r.active_luna });
const draw = (r: DrawRow): PrizeDrawRow => ({
  week: r.week, drawAt: Number(r.draw_at), blockNumber: Number(r.block_number), blockHash: r.block_hash, entries: JSON.parse(r.entries) as PrizeDrawEntry[],
  totalTickets: Number(r.total_tickets), winningTicket: r.winning_ticket === null ? null : Number(r.winning_ticket), winner: r.winner, prizeLuna: r.prize_luna,
  status: r.status, payout: r.payout, payoutTx: r.payout_tx, paidAt: r.paid_at === null ? null : Number(r.paid_at), createdAt: Number(r.created_at),
});

/** Postgres-backed store, alongside savings. Luna stays a decimal string; times are epoch ms. */
export class PgPrizeStore implements PrizeStore {
  constructor(private pool: Pick<Pool, "query">) {}

  async migrate() {
    await this.pool.query(SCHEMA);
  }
  /** True if the row went in, false if its key was taken (see PgSaveStore.insertOnce). */
  private async insertOnce(sql: string, params: unknown[]): Promise<boolean> {
    try {
      return (await this.pool.query(sql, params)).rows.length > 0;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return false;
      throw e;
    }
  }
  async useNonce(nonce: string, at: number) {
    await this.pool.query(`DELETE FROM prize_nonces WHERE created_at < $1`, [at - NONCE_TTL_MS]);
    return this.insertOnce(
      `INSERT INTO prize_nonces (nonce, created_at) SELECT $1::text, $2::bigint WHERE NOT EXISTS (SELECT 1 FROM prize_nonces WHERE nonce = $1) RETURNING nonce`,
      [nonce, at],
    );
  }
  async entry(address: string) {
    const r = await this.pool.query<EntryRow>(`SELECT * FROM prize_entries WHERE address = $1`, [address]);
    return r.rows[0] ? entry(r.rows[0]) : undefined;
  }
  async entryByDevice(device: string) {
    const r = await this.pool.query<EntryRow>(`SELECT * FROM prize_entries WHERE device = $1`, [device]);
    return r.rows[0] ? entry(r.rows[0]) : undefined;
  }
  async join(row: PrizeEntryRow) {
    await this.pool.query(`DELETE FROM prize_entries WHERE address = $1`, [row.address]);
    await this.pool.query(`INSERT INTO prize_entries (address, device, joined_at, checked_at) VALUES ($1,$2,$3,$4)`, [row.address, row.device, row.joinedAt, row.checkedAt]);
  }
  async leave(address: string) {
    await this.pool.query(`DELETE FROM prize_entries WHERE address = $1`, [address]);
  }
  async entries() {
    const r = await this.pool.query<EntryRow>(`SELECT * FROM prize_entries ORDER BY joined_at`);
    return r.rows.map(entry);
  }
  async due(before: number, limit: number) {
    const r = await this.pool.query<EntryRow>(
      `SELECT * FROM prize_entries WHERE COALESCE(checked_at, 0) < $1 ORDER BY COALESCE(checked_at, 0) LIMIT $2`,
      [before, limit],
    );
    return r.rows.map(entry);
  }
  async addCheck(x: PrizeCheckRow) {
    await this.pool.query(`INSERT INTO prize_checks (address, at, active_luna) VALUES ($1,$2,$3)`, [x.address, x.at, x.activeLuna]);
    await this.pool.query(`UPDATE prize_entries SET checked_at = $2 WHERE address = $1 AND COALESCE(checked_at, 0) < $2`, [x.address, x.at]);
  }
  async checks(address: string, since: number) {
    const before = await this.pool.query<CheckRow>(`SELECT * FROM prize_checks WHERE address = $1 AND at < $2 ORDER BY at DESC LIMIT 1`, [address, since]);
    const after = await this.pool.query<CheckRow>(`SELECT * FROM prize_checks WHERE address = $1 AND at >= $2 ORDER BY at`, [address, since]);
    return [...before.rows, ...after.rows].map(check);
  }
  async pruneChecks(before: number) {
    await this.pool.query(`DELETE FROM prize_checks WHERE at < $1`, [before]);
  }
  async draw(week: string) {
    const r = await this.pool.query<DrawRow>(`SELECT * FROM prize_draws WHERE week = $1`, [week]);
    return r.rows[0] ? draw(r.rows[0]) : undefined;
  }
  async addDraw(x: PrizeDrawRow) {
    return this.insertOnce(
      `INSERT INTO prize_draws (week, draw_at, block_number, block_hash, entries, total_tickets, winning_ticket, winner, prize_luna, status, payout, payout_tx, paid_at, created_at)
       SELECT $1::text, $2::bigint, $3::bigint, $4::text, $5::text, $6::integer, $7::integer, $8::text, $9::text, $10::text, $11::text, $12::text, $13::bigint, $14::bigint
       WHERE NOT EXISTS (SELECT 1 FROM prize_draws WHERE week = $1) RETURNING week`,
      [x.week, x.drawAt, x.blockNumber, x.blockHash, JSON.stringify(x.entries), x.totalTickets, x.winningTicket, x.winner, x.prizeLuna, x.status, x.payout, x.payoutTx, x.paidAt, x.createdAt],
    );
  }
  async draws(limit: number) {
    const r = await this.pool.query<DrawRow>(`SELECT * FROM prize_draws ORDER BY draw_at DESC LIMIT $1`, [limit]);
    return r.rows.map(draw);
  }
  async wins(address: string) {
    const r = await this.pool.query<DrawRow>(`SELECT * FROM prize_draws WHERE winner = $1 ORDER BY draw_at DESC`, [address]);
    return r.rows.map(draw);
  }
  async unpaid() {
    const r = await this.pool.query<DrawRow>(`SELECT * FROM prize_draws WHERE status = 'unpaid' ORDER BY draw_at`);
    return r.rows.map(draw);
  }
  async setPayout(week: string, payout: string) {
    await this.pool.query(`UPDATE prize_draws SET payout = $2 WHERE week = $1 AND status = 'unpaid'`, [week, payout]);
  }
  async markPaid(week: string, txHash: string, at: number) {
    await this.pool.query(`UPDATE prize_draws SET status = 'paid', payout_tx = $2, paid_at = $3 WHERE week = $1 AND status = 'unpaid'`, [week, txHash, at]);
  }
}
