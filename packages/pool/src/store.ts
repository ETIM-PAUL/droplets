import type { PoolSide } from "@railkit/core";
import type { Pool } from "pg";

export type PoolOrderStatus = "awaiting_payment" | "queued" | "filled" | "refunded" | "rejected" | "expired";

/** A deposit or withdrawal. Deposits wait for the user's payment; both fill at the next settlement. */
export interface PoolOrderRow {
  id: string;
  address: string;
  side: PoolSide;
  kind: "deposit" | "withdraw";
  /** Deposits: the luna the user said they'd send. */
  expectedLuna: string | null;
  /** Deposits: the luna that actually arrived (null until it's seen on-chain). */
  luna: string | null;
  /** Withdrawals: micro-dollars (Steady) or luna (Boost); null means all. */
  amount: string | null;
  status: PoolOrderStatus;
  txHash: string | null;
  /** Why it was refunded or rejected, or why it's still waiting. */
  note: string | null;
  createdAt: number;
  expiresAt: number | null;
  queuedAt: number | null;
  settledSeq: number | null;
}

export type PoolPayoutStatus = "pending" | "sent" | "confirmed" | "failed";

export interface PoolPayoutRow {
  id: string;
  orderId: string;
  address: string;
  luna: string;
  reason: "withdrawal" | "refund";
  status: PoolPayoutStatus;
  txHash: string | null;
  /** The signed transaction, kept so a retry resends exactly it (the payout SDK's log). */
  record: string | null;
  createdAt: number;
  updatedAt: number;
}

/** One settlement: the books afterwards, every order's result and the payouts decided, as JSON. */
export interface SettlementRow {
  seq: number;
  at: number;
  json: string;
}

export interface UnmatchedTx {
  txHash: string;
  from: string;
  luna: string;
  memo: string;
  seenAt: number;
}

export interface PoolStore {
  latestSettlement(): Promise<SettlementRow | undefined>;
  /** False if that settlement number already exists: another worker got there first. */
  addSettlement(r: SettlementRow): Promise<boolean>;
  addOrder(o: PoolOrderRow): Promise<void>;
  getOrder(id: string): Promise<PoolOrderRow | undefined>;
  updateOrder(id: string, patch: Partial<Omit<PoolOrderRow, "id">>): Promise<void>;
  ordersByStatus(status: PoolOrderStatus): Promise<PoolOrderRow[]>;
  ordersForAddress(address: string, limit: number): Promise<PoolOrderRow[]>;
  orderByTx(txHash: string): Promise<PoolOrderRow | undefined>;
  /** False if it's already there: payouts are written once. */
  addPayout(p: PoolPayoutRow): Promise<boolean>;
  getPayout(id: string): Promise<PoolPayoutRow | undefined>;
  updatePayout(id: string, patch: Partial<Omit<PoolPayoutRow, "id">>): Promise<void>;
  payoutsByStatus(status: PoolPayoutStatus): Promise<PoolPayoutRow[]>;
  payoutsForAddress(address: string, limit: number): Promise<PoolPayoutRow[]>;
  useNonce(nonce: string, at: number): Promise<boolean>;
  addUnmatched(u: UnmatchedTx): Promise<boolean>;
  listUnmatched(): Promise<UnmatchedTx[]>;
  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, value: string): Promise<void>;
}

const NONCE_TTL_MS = 86_400_000;
const byNew = <T extends { createdAt: number }>(a: T, b: T) => b.createdAt - a.createdAt;

export class MemoryPoolStore implements PoolStore {
  private settlements = new Map<number, SettlementRow>();
  private orders = new Map<string, PoolOrderRow>();
  private payouts = new Map<string, PoolPayoutRow>();
  private nonces = new Map<string, number>();
  private unmatched = new Map<string, UnmatchedTx>();
  private settings = new Map<string, string>();

  async latestSettlement() {
    const seq = Math.max(0, ...this.settlements.keys());
    return this.settlements.get(seq);
  }
  async addSettlement(r: SettlementRow) {
    if (this.settlements.has(r.seq)) return false;
    this.settlements.set(r.seq, { ...r });
    return true;
  }
  async addOrder(o: PoolOrderRow) {
    this.orders.set(o.id, { ...o });
  }
  async getOrder(id: string) {
    const o = this.orders.get(id);
    return o && { ...o };
  }
  async updateOrder(id: string, patch: Partial<Omit<PoolOrderRow, "id">>) {
    const o = this.orders.get(id);
    if (o) this.orders.set(id, { ...o, ...patch });
  }
  async ordersByStatus(status: PoolOrderStatus) {
    return [...this.orders.values()].filter((o) => o.status === status).sort((a, b) => a.createdAt - b.createdAt).map((o) => ({ ...o }));
  }
  async ordersForAddress(address: string, limit: number) {
    return [...this.orders.values()].filter((o) => o.address === address).sort(byNew).slice(0, limit).map((o) => ({ ...o }));
  }
  async orderByTx(txHash: string) {
    return [...this.orders.values()].find((o) => o.txHash === txHash);
  }
  async addPayout(p: PoolPayoutRow) {
    if (this.payouts.has(p.id)) return false;
    this.payouts.set(p.id, { ...p });
    return true;
  }
  async getPayout(id: string) {
    const p = this.payouts.get(id);
    return p && { ...p };
  }
  async updatePayout(id: string, patch: Partial<Omit<PoolPayoutRow, "id">>) {
    const p = this.payouts.get(id);
    if (p) this.payouts.set(id, { ...p, ...patch });
  }
  async payoutsByStatus(status: PoolPayoutStatus) {
    return [...this.payouts.values()].filter((p) => p.status === status).sort((a, b) => a.createdAt - b.createdAt).map((p) => ({ ...p }));
  }
  async payoutsForAddress(address: string, limit: number) {
    return [...this.payouts.values()].filter((p) => p.address === address).sort(byNew).slice(0, limit).map((p) => ({ ...p }));
  }
  async useNonce(nonce: string, at: number) {
    for (const [k, t] of this.nonces) if (at - t > NONCE_TTL_MS) this.nonces.delete(k);
    if (this.nonces.has(nonce)) return false;
    this.nonces.set(nonce, at);
    return true;
  }
  async addUnmatched(u: UnmatchedTx) {
    if (this.unmatched.has(u.txHash)) return false;
    this.unmatched.set(u.txHash, { ...u });
    return true;
  }
  async listUnmatched() {
    return [...this.unmatched.values()].sort((a, b) => b.seenAt - a.seenAt);
  }
  async getSetting(key: string) {
    return this.settings.get(key);
  }
  async setSetting(key: string, value: string) {
    this.settings.set(key, value);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pool_settlements (seq INTEGER PRIMARY KEY, at BIGINT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pool_orders (
  id TEXT PRIMARY KEY, address TEXT NOT NULL, side TEXT NOT NULL, kind TEXT NOT NULL,
  expected_luna TEXT, luna TEXT, amount TEXT, status TEXT NOT NULL, tx_hash TEXT, note TEXT,
  created_at BIGINT NOT NULL, expires_at BIGINT, queued_at BIGINT, settled_seq INTEGER
);
CREATE INDEX IF NOT EXISTS pool_orders_status ON pool_orders (status, created_at);
CREATE INDEX IF NOT EXISTS pool_orders_address ON pool_orders (address, created_at);
CREATE TABLE IF NOT EXISTS pool_payouts (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, address TEXT NOT NULL, luna TEXT NOT NULL, reason TEXT NOT NULL,
  status TEXT NOT NULL, tx_hash TEXT, record TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS pool_payouts_status ON pool_payouts (status, created_at);
CREATE TABLE IF NOT EXISTS pool_nonces (nonce TEXT PRIMARY KEY, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS pool_unmatched (tx_hash TEXT PRIMARY KEY, from_address TEXT NOT NULL, luna TEXT NOT NULL, memo TEXT NOT NULL, seen_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS pool_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`;

const ORDER_COLS: Record<keyof Omit<PoolOrderRow, "id">, string> = {
  address: "address", side: "side", kind: "kind", expectedLuna: "expected_luna", luna: "luna", amount: "amount", status: "status", txHash: "tx_hash",
  note: "note", createdAt: "created_at", expiresAt: "expires_at", queuedAt: "queued_at", settledSeq: "settled_seq",
};
const PAYOUT_COLS: Record<keyof Omit<PoolPayoutRow, "id">, string> = {
  orderId: "order_id", address: "address", luna: "luna", reason: "reason", status: "status", txHash: "tx_hash", record: "record", createdAt: "created_at", updatedAt: "updated_at",
};
const BIGINT_COLS = new Set(["created_at", "expires_at", "queued_at", "updated_at"]);
const INT_COLS = new Set(["settled_seq"]);

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const orderFrom = (r: Row): PoolOrderRow => ({
  id: r.id as string, address: r.address as string, side: r.side as PoolSide, kind: r.kind as PoolOrderRow["kind"], expectedLuna: (r.expected_luna as string) ?? null,
  luna: (r.luna as string) ?? null, amount: (r.amount as string) ?? null, status: r.status as PoolOrderStatus, txHash: (r.tx_hash as string) ?? null, note: (r.note as string) ?? null,
  createdAt: Number(r.created_at), expiresAt: num(r.expires_at), queuedAt: num(r.queued_at), settledSeq: num(r.settled_seq),
});
const payoutFrom = (r: Row): PoolPayoutRow => ({
  id: r.id as string, orderId: r.order_id as string, address: r.address as string, luna: r.luna as string, reason: r.reason as PoolPayoutRow["reason"],
  status: r.status as PoolPayoutStatus, txHash: (r.tx_hash as string) ?? null, record: (r.record as string) ?? null, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
});

/** Postgres-backed, next to the order log. Luna stays a decimal string; times are epoch ms. */
export class PgPoolStore implements PoolStore {
  constructor(private pool: Pick<Pool, "query">) {}

  async migrate() {
    await this.pool.query(SCHEMA);
  }
  /** True if the row went in. Not ON CONFLICT … RETURNING: pg-mem returns the existing row for that. */
  private async insertOnce(sql: string, params: unknown[]) {
    try {
      return (await this.pool.query(sql, params)).rows.length > 0;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return false;
      throw e;
    }
  }
  private async update(table: string, cols: Record<string, string>, id: string, patch: Record<string, unknown>) {
    const keys = Object.keys(patch).filter((k) => k in cols);
    if (!keys.length) return;
    const sets = keys.map((k, i) => {
      const col = cols[k]!;
      const cast = BIGINT_COLS.has(col) ? "::bigint" : INT_COLS.has(col) ? "::integer" : "::text";
      return `${col} = $${i + 2}${cast}`;
    });
    await this.pool.query(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = $1`, [id, ...keys.map((k) => patch[k] ?? null)]);
  }

  async latestSettlement() {
    const r = await this.pool.query<Row>(`SELECT * FROM pool_settlements ORDER BY seq DESC LIMIT 1`);
    return r.rows[0] ? { seq: Number(r.rows[0].seq), at: Number(r.rows[0].at), json: r.rows[0].json as string } : undefined;
  }
  async addSettlement(x: SettlementRow) {
    return this.insertOnce(
      `INSERT INTO pool_settlements (seq, at, json) SELECT $1::integer, $2::bigint, $3::text WHERE NOT EXISTS (SELECT 1 FROM pool_settlements WHERE seq = $1) RETURNING seq`,
      [x.seq, x.at, x.json],
    );
  }
  async addOrder(o: PoolOrderRow) {
    await this.pool.query(
      `INSERT INTO pool_orders (id, address, side, kind, expected_luna, luna, amount, status, tx_hash, note, created_at, expires_at, queued_at, settled_seq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [o.id, o.address, o.side, o.kind, o.expectedLuna, o.luna, o.amount, o.status, o.txHash, o.note, o.createdAt, o.expiresAt, o.queuedAt, o.settledSeq],
    );
  }
  async getOrder(id: string) {
    const r = await this.pool.query<Row>(`SELECT * FROM pool_orders WHERE id = $1`, [id]);
    return r.rows[0] ? orderFrom(r.rows[0]) : undefined;
  }
  async updateOrder(id: string, patch: Partial<Omit<PoolOrderRow, "id">>) {
    await this.update("pool_orders", ORDER_COLS, id, patch);
  }
  async ordersByStatus(status: PoolOrderStatus) {
    const r = await this.pool.query<Row>(`SELECT * FROM pool_orders WHERE status = $1 ORDER BY created_at`, [status]);
    return r.rows.map(orderFrom);
  }
  async ordersForAddress(address: string, limit: number) {
    const r = await this.pool.query<Row>(`SELECT * FROM pool_orders WHERE address = $1 ORDER BY created_at DESC LIMIT $2`, [address, limit]);
    return r.rows.map(orderFrom);
  }
  async orderByTx(txHash: string) {
    const r = await this.pool.query<Row>(`SELECT * FROM pool_orders WHERE tx_hash = $1`, [txHash]);
    return r.rows[0] ? orderFrom(r.rows[0]) : undefined;
  }
  async addPayout(p: PoolPayoutRow) {
    return this.insertOnce(
      `INSERT INTO pool_payouts (id, order_id, address, luna, reason, status, tx_hash, record, created_at, updated_at)
       SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::bigint, $10::bigint
       WHERE NOT EXISTS (SELECT 1 FROM pool_payouts WHERE id = $1) RETURNING id`,
      [p.id, p.orderId, p.address, p.luna, p.reason, p.status, p.txHash, p.record, p.createdAt, p.updatedAt],
    );
  }
  async getPayout(id: string) {
    const r = await this.pool.query<Row>(`SELECT * FROM pool_payouts WHERE id = $1`, [id]);
    return r.rows[0] ? payoutFrom(r.rows[0]) : undefined;
  }
  async updatePayout(id: string, patch: Partial<Omit<PoolPayoutRow, "id">>) {
    await this.update("pool_payouts", PAYOUT_COLS, id, patch);
  }
  async payoutsByStatus(status: PoolPayoutStatus) {
    const r = await this.pool.query<Row>(`SELECT * FROM pool_payouts WHERE status = $1 ORDER BY created_at`, [status]);
    return r.rows.map(payoutFrom);
  }
  async payoutsForAddress(address: string, limit: number) {
    const r = await this.pool.query<Row>(`SELECT * FROM pool_payouts WHERE address = $1 ORDER BY created_at DESC LIMIT $2`, [address, limit]);
    return r.rows.map(payoutFrom);
  }
  async useNonce(nonce: string, at: number) {
    await this.pool.query(`DELETE FROM pool_nonces WHERE created_at < $1`, [at - NONCE_TTL_MS]);
    return this.insertOnce(`INSERT INTO pool_nonces (nonce, created_at) SELECT $1::text, $2::bigint WHERE NOT EXISTS (SELECT 1 FROM pool_nonces WHERE nonce = $1) RETURNING nonce`, [nonce, at]);
  }
  async addUnmatched(u: UnmatchedTx) {
    return this.insertOnce(
      `INSERT INTO pool_unmatched (tx_hash, from_address, luna, memo, seen_at) SELECT $1::text, $2::text, $3::text, $4::text, $5::bigint
       WHERE NOT EXISTS (SELECT 1 FROM pool_unmatched WHERE tx_hash = $1) RETURNING tx_hash`,
      [u.txHash, u.from, u.luna, u.memo, u.seenAt],
    );
  }
  async listUnmatched() {
    const r = await this.pool.query<Row>(`SELECT * FROM pool_unmatched ORDER BY seen_at DESC`);
    return r.rows.map((x) => ({ txHash: x.tx_hash as string, from: x.from_address as string, luna: x.luna as string, memo: x.memo as string, seenAt: Number(x.seen_at) }));
  }
  async getSetting(key: string) {
    const r = await this.pool.query<Row>(`SELECT value FROM pool_settings WHERE key = $1`, [key]);
    return r.rows[0]?.value as string | undefined;
  }
  async setSetting(key: string, value: string) {
    if (!(await this.insertOnce(`INSERT INTO pool_settings (key, value) SELECT $1::text, $2::text WHERE NOT EXISTS (SELECT 1 FROM pool_settings WHERE key = $1) RETURNING key`, [key, value]))) {
      await this.pool.query(`UPDATE pool_settings SET value = $2 WHERE key = $1`, [key, value]);
    }
  }
}
