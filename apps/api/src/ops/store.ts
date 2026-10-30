import type { Pool } from "pg";

export type OrderKind = "payout" | "airtime" | "topup";
/** Our own view of an order, kept server-side for alerts and metrics. "done" means delivered to the recipient. */
export type OpsState = "awaiting_payment" | "paid" | "done" | "failed" | "expired";

export interface OpsOrder {
  id: string;
  kind: OrderKind;
  /** Which beta invite placed it; null when invites are off. */
  invite: string | null;
  /** Corridor id for payouts, country for airtime, "provider:country" for top-ups. */
  product: string;
  receiveAmount: string;
  receiveCurrency: string;
  sats: string;
  createdAt: number;
  /** When the quote's invoice stops being payable. */
  expiresAt: number;
  state: OpsState;
  updatedAt: number;
  alertedAt: number | null;
}

export interface Feedback {
  id: string;
  invite: string | null;
  orderId: string | null;
  message: string;
  createdAt: number;
}

export interface OpsStore {
  recordQuote(o: Omit<OpsOrder, "state" | "updatedAt" | "alertedAt">): Promise<void>;
  setState(id: string, state: OpsState, at: number): Promise<void>;
  get(id: string): Promise<OpsOrder | undefined>;
  listSince(ms: number): Promise<OpsOrder[]>;
  markAlerted(id: string, at: number): Promise<void>;
  addFeedback(f: Feedback): Promise<void>;
  listFeedback(sinceMs: number): Promise<Feedback[]>;
}

export class MemoryOpsStore implements OpsStore {
  private orders = new Map<string, OpsOrder>();
  private feedback: Feedback[] = [];
  async recordQuote(o: Omit<OpsOrder, "state" | "updatedAt" | "alertedAt">) {
    if (this.orders.has(o.id)) return; // same as Postgres: a replayed quote changes nothing
    this.orders.set(o.id, { ...o, state: "awaiting_payment", updatedAt: o.createdAt, alertedAt: null });
  }
  async setState(id: string, state: OpsState, at: number) {
    const o = this.orders.get(id);
    if (o && o.state !== state) this.orders.set(id, { ...o, state, updatedAt: at });
  }
  async get(id: string) {
    return this.orders.get(id);
  }
  async listSince(ms: number) {
    return [...this.orders.values()].filter((o) => o.createdAt >= ms).sort((a, b) => b.createdAt - a.createdAt);
  }
  async markAlerted(id: string, at: number) {
    const o = this.orders.get(id);
    if (o) this.orders.set(id, { ...o, alertedAt: at });
  }
  async addFeedback(f: Feedback) {
    this.feedback.push(f);
  }
  async listFeedback(sinceMs: number) {
    return this.feedback.filter((f) => f.createdAt >= sinceMs).sort((a, b) => b.createdAt - a.createdAt);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ops_orders (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  invite TEXT,
  product TEXT NOT NULL,
  receive_amount TEXT NOT NULL,
  receive_currency TEXT NOT NULL,
  sats TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  state TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  alerted_at BIGINT
);
CREATE INDEX IF NOT EXISTS ops_orders_created ON ops_orders (created_at);
CREATE TABLE IF NOT EXISTS ops_feedback (
  id TEXT PRIMARY KEY,
  invite TEXT,
  order_id TEXT,
  message TEXT NOT NULL,
  created_at BIGINT NOT NULL
);`;

interface Row {
  id: string;
  kind: OrderKind;
  invite: string | null;
  product: string;
  receive_amount: string;
  receive_currency: string;
  sats: string;
  created_at: string | number;
  expires_at: string | number;
  state: OpsState;
  updated_at: string | number;
  alerted_at: string | number | null;
}
const fromRow = (r: Row): OpsOrder => ({
  id: r.id,
  kind: r.kind,
  invite: r.invite,
  product: r.product,
  receiveAmount: r.receive_amount,
  receiveCurrency: r.receive_currency,
  sats: r.sats,
  createdAt: Number(r.created_at),
  expiresAt: Number(r.expires_at),
  state: r.state,
  updatedAt: Number(r.updated_at),
  alertedAt: r.alerted_at === null ? null : Number(r.alerted_at),
});

/** Postgres-backed store. Money stays as decimal strings; times are epoch ms. */
export class PgOpsStore implements OpsStore {
  constructor(private pool: Pick<Pool, "query">) {}

  async migrate() {
    await this.pool.query(SCHEMA);
  }
  async recordQuote(o: Omit<OpsOrder, "state" | "updatedAt" | "alertedAt">) {
    await this.pool.query(
      `INSERT INTO ops_orders (id, kind, invite, product, receive_amount, receive_currency, sats, created_at, expires_at, state, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'awaiting_payment',$8) ON CONFLICT (id) DO NOTHING`,
      [o.id, o.kind, o.invite, o.product, o.receiveAmount, o.receiveCurrency, o.sats, o.createdAt, o.expiresAt],
    );
  }
  async setState(id: string, state: OpsState, at: number) {
    await this.pool.query(`UPDATE ops_orders SET state = $2, updated_at = $3 WHERE id = $1 AND state <> $2`, [id, state, at]);
  }
  async get(id: string) {
    const r = await this.pool.query<Row>(`SELECT * FROM ops_orders WHERE id = $1`, [id]);
    return r.rows[0] ? fromRow(r.rows[0]) : undefined;
  }
  async listSince(ms: number) {
    const r = await this.pool.query<Row>(`SELECT * FROM ops_orders WHERE created_at >= $1 ORDER BY created_at DESC`, [ms]);
    return r.rows.map(fromRow);
  }
  async markAlerted(id: string, at: number) {
    await this.pool.query(`UPDATE ops_orders SET alerted_at = $2 WHERE id = $1`, [id, at]);
  }
  async addFeedback(f: Feedback) {
    await this.pool.query(`INSERT INTO ops_feedback (id, invite, order_id, message, created_at) VALUES ($1,$2,$3,$4,$5)`, [
      f.id, f.invite, f.orderId, f.message, f.createdAt,
    ]);
  }
  async listFeedback(sinceMs: number) {
    const r = await this.pool.query<{ id: string; invite: string | null; order_id: string | null; message: string; created_at: string | number }>(
      `SELECT * FROM ops_feedback WHERE created_at >= $1 ORDER BY created_at DESC`,
      [sinceMs],
    );
    return r.rows.map((x) => ({ id: x.id, invite: x.invite, orderId: x.order_id, message: x.message, createdAt: Number(x.created_at) }));
  }
}
