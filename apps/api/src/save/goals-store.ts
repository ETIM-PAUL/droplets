import { MAX_GOALS } from "@railkit/core";
import type { Pool } from "pg";

/** A named slice of one address's own savings. Droplets holds none of this money: see packages/core/src/goals.ts. */
export interface GoalRow {
  id: string;
  address: string;
  name: string;
  /** Luna, decimal string; null for no target. */
  targetLuna: string | null;
  /** Midnight UTC on that date, ms since 1970; null for no date. */
  dueAt: number | null;
  /** Fill order: lower first. */
  order: number;
  /** How much of the address's stake is currently earmarked for this goal. */
  allocatedLuna: string;
  breakRequestedAt: number | null;
  breachedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type GoalEdit = Partial<Pick<GoalRow, "name" | "targetLuna" | "dueAt">>;

export interface GoalStore {
  listGoals(address: string): Promise<GoalRow[]>;
  getGoal(address: string, id: string): Promise<GoalRow | undefined>;
  /** False when the address already has MAX_GOALS. */
  insertGoal(row: Omit<GoalRow, "order">): Promise<boolean>;
  updateGoal(address: string, id: string, fields: GoalEdit, at: number): Promise<boolean>;
  /** False unless `order` names exactly this address's current goals, once each. */
  reorderGoals(address: string, order: string[], at: number): Promise<boolean>;
  deleteGoal(address: string, id: string): Promise<boolean>;
  requestBreak(address: string, id: string, at: number): Promise<boolean>;
  /** Applies a reconciliation: new allocatedLuna for the goals that changed, and newly breached ones. */
  applyGoalChanges(changes: Map<string, bigint>, breached: Set<string>, at: number): Promise<void>;
  /** The stake total last reconciled for this address; undefined before the first reconciliation. */
  goalCursor(address: string): Promise<bigint | undefined>;
  setGoalCursor(address: string, totalLuna: bigint, at: number): Promise<void>;
  /** When Droplets refuses a new goal until, after a withdrawal outside Droplets reached into a locked one; null if not banned. */
  goalBanUntil(address: string): Promise<number | null>;
  /** Extends the ban to `until`, never shortening one already further out. */
  banGoals(address: string, until: number): Promise<void>;
}

export class MemoryGoalStore implements GoalStore {
  private goals = new Map<string, GoalRow>();
  private cursors = new Map<string, bigint>();
  private bans = new Map<string, number>();

  async listGoals(address: string) {
    return [...this.goals.values()].filter((g) => g.address === address).sort((a, b) => a.order - b.order);
  }
  async getGoal(address: string, id: string) {
    const g = this.goals.get(id);
    return g && g.address === address ? g : undefined;
  }
  async insertGoal(row: Omit<GoalRow, "order">) {
    const mine = await this.listGoals(row.address);
    if (mine.length >= MAX_GOALS) return false;
    const order = mine.length === 0 ? 0 : Math.max(...mine.map((g) => g.order)) + 1;
    this.goals.set(row.id, { ...row, order });
    return true;
  }
  async updateGoal(address: string, id: string, fields: GoalEdit, at: number) {
    const g = await this.getGoal(address, id);
    if (!g) return false;
    this.goals.set(id, { ...g, ...fields, updatedAt: at });
    return true;
  }
  async reorderGoals(address: string, order: string[], at: number) {
    const mine = await this.listGoals(address);
    if (mine.length !== order.length || !mine.every((g) => order.includes(g.id))) return false;
    for (const [i, id] of order.entries()) {
      const g = this.goals.get(id)!;
      this.goals.set(id, { ...g, order: i, updatedAt: at });
    }
    return true;
  }
  async deleteGoal(address: string, id: string) {
    const g = await this.getGoal(address, id);
    if (!g) return false;
    this.goals.delete(id);
    return true;
  }
  async requestBreak(address: string, id: string, at: number) {
    const g = await this.getGoal(address, id);
    if (!g) return false;
    this.goals.set(id, { ...g, breakRequestedAt: g.breakRequestedAt ?? at, updatedAt: at });
    return true;
  }
  async applyGoalChanges(changes: Map<string, bigint>, breached: Set<string>, at: number) {
    for (const [id, luna] of changes) {
      const g = this.goals.get(id);
      if (g) this.goals.set(id, { ...g, allocatedLuna: luna.toString(), breachedAt: breached.has(id) ? (g.breachedAt ?? at) : g.breachedAt, updatedAt: at });
    }
  }
  async goalCursor(address: string) {
    return this.cursors.get(address);
  }
  async setGoalCursor(address: string, totalLuna: bigint) {
    this.cursors.set(address, totalLuna);
  }
  async goalBanUntil(address: string) {
    return this.bans.get(address) ?? null;
  }
  async banGoals(address: string, until: number) {
    const cur = this.bans.get(address);
    if (cur === undefined || until > cur) this.bans.set(address, until);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS save_goals (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  name TEXT NOT NULL,
  target_luna TEXT,
  due_at BIGINT,
  goal_order INTEGER NOT NULL,
  allocated_luna TEXT NOT NULL DEFAULT '0',
  break_requested_at BIGINT,
  breached_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS save_goals_address ON save_goals (address, goal_order);
CREATE TABLE IF NOT EXISTS save_goal_cursors (
  address TEXT PRIMARY KEY,
  total_luna TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
ALTER TABLE save_goal_cursors ADD COLUMN IF NOT EXISTS banned_until BIGINT;`;

type Num = string | number;
interface Row {
  id: string; address: string; name: string; target_luna: string | null; due_at: Num | null; goal_order: Num; allocated_luna: string;
  break_requested_at: Num | null; breached_at: Num | null; created_at: Num; updated_at: Num;
}
const fromRow = (r: Row): GoalRow => ({
  id: r.id, address: r.address, name: r.name, targetLuna: r.target_luna, dueAt: r.due_at === null ? null : Number(r.due_at), order: Number(r.goal_order),
  allocatedLuna: r.allocated_luna, breakRequestedAt: r.break_requested_at === null ? null : Number(r.break_requested_at),
  breachedAt: r.breached_at === null ? null : Number(r.breached_at), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
});

/** Postgres-backed store, alongside the rest of save. Luna stays a decimal string; times are epoch ms. */
export class PgGoalStore implements GoalStore {
  constructor(private pool: Pick<Pool, "query">) {}

  async migrate() {
    await this.pool.query(SCHEMA);
  }
  async listGoals(address: string) {
    const r = await this.pool.query<Row>(`SELECT * FROM save_goals WHERE address = $1 ORDER BY goal_order`, [address]);
    return r.rows.map(fromRow);
  }
  async getGoal(address: string, id: string) {
    const r = await this.pool.query<Row>(`SELECT * FROM save_goals WHERE id = $1 AND address = $2`, [id, address]);
    return r.rows[0] ? fromRow(r.rows[0]) : undefined;
  }
  async insertGoal(row: Omit<GoalRow, "order">) {
    // Read then write, not one atomic statement (pg-mem, used in tests, chokes on the combined form): a race between
    // two creates at once could in principle give two goals the same order, which just means they tie for fill order.
    const agg = await this.pool.query<{ count: string; max_order: number | string | null }>(
      `SELECT COUNT(*)::int AS count, MAX(goal_order) AS max_order FROM save_goals WHERE address = $1`,
      [row.address],
    );
    const { count, max_order } = agg.rows[0]!;
    if (Number(count) >= MAX_GOALS) return false;
    const order = max_order === null ? 0 : Number(max_order) + 1;
    await this.pool.query(
      `INSERT INTO save_goals (id, address, name, target_luna, due_at, goal_order, allocated_luna, break_requested_at, breached_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NULL,$8,$9)`,
      [row.id, row.address, row.name, row.targetLuna, row.dueAt, order, row.allocatedLuna, row.createdAt, row.updatedAt],
    );
    return true;
  }
  async updateGoal(address: string, id: string, fields: GoalEdit, at: number) {
    const cols: [string, unknown][] = [];
    if (fields.name !== undefined) cols.push(["name", fields.name]);
    if ("targetLuna" in fields) cols.push(["target_luna", fields.targetLuna ?? null]);
    if ("dueAt" in fields) cols.push(["due_at", fields.dueAt ?? null]);
    cols.push(["updated_at", at]);
    const set = cols.map(([c], i) => `${c} = $${i + 3}`).join(", ");
    const r = await this.pool.query(`UPDATE save_goals SET ${set} WHERE id = $1 AND address = $2`, [id, address, ...cols.map(([, v]) => v)]);
    return (r.rowCount ?? 0) > 0;
  }
  async reorderGoals(address: string, order: string[], at: number) {
    const mine = await this.listGoals(address);
    if (mine.length !== order.length || !mine.every((g) => order.includes(g.id))) return false;
    for (const [i, id] of order.entries()) await this.pool.query(`UPDATE save_goals SET goal_order = $3, updated_at = $4 WHERE id = $1 AND address = $2`, [id, address, i, at]);
    return true;
  }
  async deleteGoal(address: string, id: string) {
    const r = await this.pool.query(`DELETE FROM save_goals WHERE id = $1 AND address = $2`, [id, address]);
    return (r.rowCount ?? 0) > 0;
  }
  async requestBreak(address: string, id: string, at: number) {
    const r = await this.pool.query(`UPDATE save_goals SET break_requested_at = COALESCE(break_requested_at, $3), updated_at = $3 WHERE id = $1 AND address = $2`, [id, address, at]);
    return (r.rowCount ?? 0) > 0;
  }
  async applyGoalChanges(changes: Map<string, bigint>, breached: Set<string>, at: number) {
    for (const [id, luna] of changes) {
      await this.pool.query(
        `UPDATE save_goals SET allocated_luna = $2, breached_at = CASE WHEN $3 THEN COALESCE(breached_at, $4) ELSE breached_at END, updated_at = $4 WHERE id = $1`,
        [id, luna.toString(), breached.has(id), at],
      );
    }
  }
  async goalCursor(address: string) {
    const r = await this.pool.query<{ total_luna: string }>(`SELECT total_luna FROM save_goal_cursors WHERE address = $1`, [address]);
    return r.rows[0] ? BigInt(r.rows[0].total_luna) : undefined;
  }
  async setGoalCursor(address: string, totalLuna: bigint, at: number) {
    // The ban (if any) is kept: this upsert only ever touches total_luna and updated_at.
    await this.pool.query(
      `INSERT INTO save_goal_cursors (address, total_luna, updated_at) VALUES ($1,$2,$3)
       ON CONFLICT (address) DO UPDATE SET total_luna = $2, updated_at = $3`,
      [address, totalLuna.toString(), at],
    );
  }
  async goalBanUntil(address: string) {
    const r = await this.pool.query<{ banned_until: string | number | null }>(`SELECT banned_until FROM save_goal_cursors WHERE address = $1`, [address]);
    const v = r.rows[0]?.banned_until;
    return v === undefined || v === null ? null : Number(v);
  }
  async banGoals(address: string, until: number) {
    // A cursor row is guaranteed to exist by the time a ban is possible: a breach is only ever found while
    // reconciling a change against an existing cursor, never on the first reconciliation for an address.
    await this.pool.query(`UPDATE save_goal_cursors SET banned_until = GREATEST(COALESCE(banned_until, 0), $2) WHERE address = $1`, [address, until]);
  }
}
