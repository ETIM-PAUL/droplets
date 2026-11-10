import type { CatchUpEvery } from "@railkit/core";
import type { Pool } from "pg";

/** A user's save code and rule. One active code per address; revoked codes stay for the record. */
export interface SaveCodeRow {
  code: string;
  address: string;
  /** Share of each payment from an app that goes to savings. */
  savePercent: number;
  /** Share added on top, and saved, when the user pays an app. */
  spendPercent: number;
  /** Apps the user allowed to recognise their address, by id. Others need the code. */
  appIds: string[];
  /** How often Droplets offers to save the share of spending elsewhere. */
  catchUpEvery: CatchUpEvery;
  /** When saving when paying was turned on or last changed: catch-ups never reach back before this. 0 if never recorded. */
  catchUpFrom: number;
  /** The phone's time zone when the rule was last saved, in minutes east of UTC: catch-up periods follow it. */
  tzOffsetMinutes: number | null;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
}

/** A Mini App that pays rewards with save codes. Only a hash of its key is kept. */
export interface SaveApp {
  id: string;
  name: string;
  keyHash: string;
  /** The addresses it pays from; receipts from anywhere else are refused. */
  payoutAddresses: string[];
  createdAt: number;
  /** Signed up on the landing page and not approved yet: its key doesn't work, and people can't pick it. */
  pending?: boolean;
  /** Its website or Mini App address, shown in the public list of apps. */
  url?: string | null;
  /** How to reach its developer, for the review. Never shown publicly. */
  contact?: string | null;
}

/** What the admin page can change about an app. */
export type AppEdit = Partial<Pick<SaveApp, "name" | "url" | "contact" | "payoutAddresses">>;

/** One verified payment an app made to a saver, as shown in the user's history. */
export interface SaveReceipt {
  txHash: string;
  code: string;
  address: string;
  appId: string;
  kind: "wallet" | "grow";
  /** "payout": the app paid the user. "spend": the user paid the app, and this is the part saved on top. */
  source: "payout" | "spend";
  luna: string;
  payoutId: string;
  blockNumber: number;
  createdAt: number;
}

/** What an app has done through Droplets, for the admin page. Amounts are luna, as decimal strings. */
export interface AppUsage {
  /** Payments it reported that checked out on-chain; each payout, or saving on top of a purchase, counts once. */
  payments: number;
  /** Different people it paid or saved for. */
  people: number;
  /** Put into people's savings, and how much of that was saved on top of their purchases. */
  savedLuna: string;
  fromSpendLuna: string;
  /** Paid to people's wallets. */
  walletLuna: string;
  /** People whose current rule picks the app. */
  pickedBy: number;
  lastPaymentAt: number | null;
}

export const NO_USAGE: AppUsage = { payments: 0, people: 0, savedLuna: "0", fromSpendLuna: "0", walletLuna: "0", pickedBy: 0, lastPaymentAt: null };

/** Adds up each app's usage from its receipts and the apps picked in current rules. Both stores use it. */
export function usageFrom(
  receipts: Pick<SaveReceipt, "appId" | "kind" | "source" | "luna" | "payoutId" | "address" | "createdAt">[],
  pickedAppIds: string[][],
): Map<string, AppUsage> {
  const acc = new Map<string, { payouts: Set<string>; people: Set<string>; saved: bigint; fromSpend: bigint; wallet: bigint; last: number | null; pickedBy: number }>();
  const of = (id: string) => {
    let a = acc.get(id);
    if (!a) {
      a = { payouts: new Set(), people: new Set(), saved: 0n, fromSpend: 0n, wallet: 0n, last: null, pickedBy: 0 };
      acc.set(id, a);
    }
    return a;
  };
  for (const r of receipts) {
    const a = of(r.appId);
    a.payouts.add(r.payoutId);
    a.people.add(r.address);
    if (r.kind === "grow") {
      a.saved += BigInt(r.luna);
      if (r.source === "spend") a.fromSpend += BigInt(r.luna);
    } else a.wallet += BigInt(r.luna);
    a.last = Math.max(a.last ?? 0, r.createdAt);
  }
  for (const ids of pickedAppIds) for (const id of new Set(ids)) of(id).pickedBy++;
  return new Map(
    [...acc].map(([id, a]) => [
      id,
      {
        payments: a.payouts.size, people: a.people.size, savedLuna: a.saved.toString(), fromSpendLuna: a.fromSpend.toString(),
        walletLuna: a.wallet.toString(), pickedBy: a.pickedBy, lastPaymentAt: a.last,
      },
    ]),
  );
}

/** A catch-up the user saved: the spending before `periodTo` is settled, the next one starts there. */
export interface SaveCatchUp {
  address: string;
  periodTo: number;
  /** The user's own add-stake that settled it. */
  txHash: string;
  luna: string;
  createdAt: number;
}

/** How one payout was split, recorded when the paying app says which payout it is. It answers "why did that go to my wallet?". */
export interface SaveSplitRow {
  appId: string;
  payoutId: string;
  code: string;
  address: string;
  walletLuna: string;
  growLuna: string;
  reason: null | "no-stake" | "validator-gone" | "below-minimum";
  savePercent: number;
  createdAt: number;
}

export interface SaveStore {
  activeCodeByAddress(address: string): Promise<SaveCodeRow | undefined>;
  activeCode(code: string): Promise<SaveCodeRow | undefined>;
  /** False when the code is already taken (a collision; pick another). */
  insertCode(row: SaveCodeRow): Promise<boolean>;
  updateRule(code: string, rule: Pick<SaveCodeRow, "savePercent" | "spendPercent" | "appIds" | "catchUpEvery" | "catchUpFrom" | "tzOffsetMinutes">, at: number): Promise<void>;
  revoke(code: string, at: number): Promise<void>;
  /** True the first time a nonce is seen, false after; old nonces are forgotten after a day. */
  useNonce(nonce: string, at: number): Promise<boolean>;
  addApp(app: SaveApp): Promise<void>;
  appByKeyHash(keyHash: string): Promise<SaveApp | undefined>;
  listApps(): Promise<SaveApp[]>;
  /** False when there's no such app. */
  approveApp(id: string): Promise<boolean>;
  /** False when there's no such app. Its key stops working. */
  removeApp(id: string): Promise<boolean>;
  /** Changes only the fields given. False when there's no such app. */
  updateApp(id: string, fields: AppEdit): Promise<boolean>;
  /** Gives the app a new key; the old one stops working at once. False when there's no such app. */
  setAppKey(id: string, keyHash: string): Promise<boolean>;
  /** Each app's payments, savings and the people who picked it, by app id. Apps with none are left out. */
  appUsage(): Promise<Map<string, AppUsage>>;
  /** Ignores a receipt it already has. */
  addReceipt(r: SaveReceipt): Promise<void>;
  receiptsForAddress(address: string, limit: number): Promise<SaveReceipt[]>;
  /** Keeps the first split for each app and payout: a retried payout looks its split up again. */
  addSplit(r: SaveSplitRow): Promise<void>;
  splitsForAddress(address: string, limit: number): Promise<SaveSplitRow[]>;
  /** The latest catch-up the user settled, if any. */
  lastCatchUp(address: string): Promise<SaveCatchUp | undefined>;
  /** Ignores a transaction it already has. */
  addCatchUp(c: SaveCatchUp): Promise<void>;
}

const NONCE_TTL_MS = 86_400_000;

export class MemorySaveStore implements SaveStore {
  private codes = new Map<string, SaveCodeRow>();
  private nonces = new Map<string, number>();
  private apps = new Map<string, SaveApp>();
  private receipts = new Map<string, SaveReceipt>();
  private splits = new Map<string, SaveSplitRow>();
  private catchUps = new Map<string, SaveCatchUp>();

  async activeCodeByAddress(address: string) {
    return [...this.codes.values()].find((c) => c.address === address && c.revokedAt === null);
  }
  async activeCode(code: string) {
    const c = this.codes.get(code);
    return c && c.revokedAt === null ? c : undefined;
  }
  async insertCode(row: SaveCodeRow) {
    if (this.codes.has(row.code)) return false;
    this.codes.set(row.code, { ...row, appIds: [...row.appIds] });
    return true;
  }
  async updateRule(code: string, rule: Pick<SaveCodeRow, "savePercent" | "spendPercent" | "appIds" | "catchUpEvery" | "catchUpFrom" | "tzOffsetMinutes">, at: number) {
    const c = this.codes.get(code);
    if (c) this.codes.set(code, { ...c, ...rule, appIds: [...rule.appIds], updatedAt: at });
  }
  async revoke(code: string, at: number) {
    const c = this.codes.get(code);
    if (c && c.revokedAt === null) this.codes.set(code, { ...c, revokedAt: at, updatedAt: at });
  }
  async useNonce(nonce: string, at: number) {
    for (const [n, t] of this.nonces) if (at - t > NONCE_TTL_MS) this.nonces.delete(n);
    if (this.nonces.has(nonce)) return false;
    this.nonces.set(nonce, at);
    return true;
  }
  async addApp(app: SaveApp) {
    // As Postgres gives them back: approved unless it says otherwise, and null for what's missing.
    this.apps.set(app.id, { ...app, pending: app.pending === true, url: app.url ?? null, contact: app.contact ?? null });
  }
  async appByKeyHash(keyHash: string) {
    return [...this.apps.values()].find((a) => a.keyHash === keyHash);
  }
  async listApps() {
    return [...this.apps.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
  async approveApp(id: string) {
    const a = this.apps.get(id);
    if (a) this.apps.set(id, { ...a, pending: false });
    return a !== undefined;
  }
  async removeApp(id: string) {
    return this.apps.delete(id);
  }
  async updateApp(id: string, fields: AppEdit) {
    const a = this.apps.get(id);
    if (a) this.apps.set(id, { ...a, ...fields });
    return a !== undefined;
  }
  async setAppKey(id: string, keyHash: string) {
    const a = this.apps.get(id);
    if (a) this.apps.set(id, { ...a, keyHash });
    return a !== undefined;
  }
  async appUsage() {
    const picked = [...this.codes.values()].filter((c) => c.revokedAt === null && c.appIds.length > 0).map((c) => c.appIds);
    return usageFrom([...this.receipts.values()], picked);
  }
  async addReceipt(r: SaveReceipt) {
    if (!this.receipts.has(r.txHash)) this.receipts.set(r.txHash, { ...r });
  }
  async receiptsForAddress(address: string, limit: number) {
    return [...this.receipts.values()].filter((r) => r.address === address).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }
  async addSplit(r: SaveSplitRow) {
    const k = `${r.appId}\u0000${r.payoutId}`;
    if (!this.splits.has(k)) this.splits.set(k, { ...r });
  }
  async splitsForAddress(address: string, limit: number) {
    return [...this.splits.values()].filter((r) => r.address === address).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }
  async lastCatchUp(address: string) {
    return [...this.catchUps.values()].filter((c) => c.address === address).sort((a, b) => b.periodTo - a.periodTo)[0];
  }
  async addCatchUp(c: SaveCatchUp) {
    if (!this.catchUps.has(c.txHash)) this.catchUps.set(c.txHash, { ...c });
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS save_codes (
  code TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  save_percent INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  revoked_at BIGINT
);
CREATE INDEX IF NOT EXISTS save_codes_address ON save_codes (address);
CREATE TABLE IF NOT EXISTS save_nonces (
  nonce TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS save_apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  payout_addresses TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS save_receipts (
  tx_hash TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  address TEXT NOT NULL,
  app_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  luna TEXT NOT NULL,
  payout_id TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS save_receipts_address ON save_receipts (address, created_at);
CREATE TABLE IF NOT EXISTS save_splits (
  app_id TEXT NOT NULL,
  payout_id TEXT NOT NULL,
  code TEXT NOT NULL,
  address TEXT NOT NULL,
  wallet_luna TEXT NOT NULL,
  grow_luna TEXT NOT NULL,
  reason TEXT,
  save_percent INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (app_id, payout_id)
);
CREATE INDEX IF NOT EXISTS save_splits_address ON save_splits (address, created_at);
ALTER TABLE save_codes ADD COLUMN IF NOT EXISTS spend_percent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE save_codes ADD COLUMN IF NOT EXISTS app_ids TEXT NOT NULL DEFAULT '';
ALTER TABLE save_receipts ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'payout';
ALTER TABLE save_codes ADD COLUMN IF NOT EXISTS catchup_every TEXT NOT NULL DEFAULT 'weekly';
ALTER TABLE save_codes ADD COLUMN IF NOT EXISTS catchup_from BIGINT NOT NULL DEFAULT 0;
ALTER TABLE save_codes ADD COLUMN IF NOT EXISTS tz_offset INTEGER;
ALTER TABLE save_apps ADD COLUMN IF NOT EXISTS pending BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE save_apps ADD COLUMN IF NOT EXISTS url TEXT;
ALTER TABLE save_apps ADD COLUMN IF NOT EXISTS contact TEXT;
CREATE TABLE IF NOT EXISTS save_catchups (
  tx_hash TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  period_to BIGINT NOT NULL,
  luna TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS save_catchups_address ON save_catchups (address, period_to);`;

type Num = string | number;
interface CodeRow { code: string; address: string; save_percent: Num; spend_percent: Num; app_ids: string; catchup_every: CatchUpEvery; catchup_from: Num; tz_offset: Num | null; created_at: Num; updated_at: Num; revoked_at: Num | null }
interface CatchUpRow { tx_hash: string; address: string; period_to: Num; luna: string; created_at: Num }
interface AppRow { id: string; name: string; key_hash: string; payout_addresses: string; created_at: Num; pending: boolean | null; url: string | null; contact: string | null }
interface SplitRow { app_id: string; payout_id: string; code: string; address: string; wallet_luna: string; grow_luna: string; reason: SaveSplitRow["reason"]; save_percent: Num; created_at: Num }
interface ReceiptRow { tx_hash: string; code: string; address: string; app_id: string; kind: "wallet" | "grow"; source: SaveReceipt["source"]; luna: string; payout_id: string; block_number: Num; created_at: Num }

const code = (r: CodeRow): SaveCodeRow => ({
  code: r.code, address: r.address, savePercent: Number(r.save_percent), spendPercent: Number(r.spend_percent ?? 0),
  appIds: (r.app_ids ?? "").split(",").filter(Boolean), catchUpEvery: r.catchup_every ?? "weekly", catchUpFrom: Number(r.catchup_from ?? 0),
  tzOffsetMinutes: r.tz_offset === null || r.tz_offset === undefined ? null : Number(r.tz_offset),
  createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
});
const app = (r: AppRow): SaveApp => ({
  id: r.id, name: r.name, keyHash: r.key_hash, payoutAddresses: r.payout_addresses.split(",").filter(Boolean), createdAt: Number(r.created_at),
  pending: r.pending === true, url: r.url ?? null, contact: r.contact ?? null,
});
const receipt = (r: ReceiptRow): SaveReceipt => ({
  txHash: r.tx_hash, code: r.code, address: r.address, appId: r.app_id, kind: r.kind, source: r.source ?? "payout", luna: r.luna, payoutId: r.payout_id,
  blockNumber: Number(r.block_number), createdAt: Number(r.created_at),
});

const split = (r: SplitRow): SaveSplitRow => ({
  appId: r.app_id, payoutId: r.payout_id, code: r.code, address: r.address, walletLuna: r.wallet_luna, growLuna: r.grow_luna,
  reason: r.reason, savePercent: Number(r.save_percent), createdAt: Number(r.created_at),
});

/** Postgres-backed store, alongside the order log. Luna stays a decimal string; times are epoch ms. */
export class PgSaveStore implements SaveStore {
  constructor(private pool: Pick<Pool, "query">) {}

  async migrate() {
    await this.pool.query(SCHEMA);
  }
  /**
   * True if the row went in, false if its key was already taken. Not ON CONFLICT DO NOTHING RETURNING:
   * pg-mem returns the existing row for that. Two racing inserts end in a unique violation, which also means taken.
   */
  private async insertOnce(sql: string, params: unknown[]): Promise<boolean> {
    try {
      return (await this.pool.query(sql, params)).rows.length > 0;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return false;
      throw e;
    }
  }
  async activeCodeByAddress(address: string) {
    const r = await this.pool.query<CodeRow>(`SELECT * FROM save_codes WHERE address = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [address]);
    return r.rows[0] ? code(r.rows[0]) : undefined;
  }
  async activeCode(c: string) {
    const r = await this.pool.query<CodeRow>(`SELECT * FROM save_codes WHERE code = $1 AND revoked_at IS NULL`, [c]);
    return r.rows[0] ? code(r.rows[0]) : undefined;
  }
  async insertCode(row: SaveCodeRow) {
    return this.insertOnce(
      `INSERT INTO save_codes (code, address, save_percent, spend_percent, app_ids, catchup_every, catchup_from, tz_offset, created_at, updated_at, revoked_at)
       SELECT $1::text, $2::text, $3::integer, $4::integer, $5::text, $6::text, $7::bigint, $8::integer, $9::bigint, $10::bigint, NULL
       WHERE NOT EXISTS (SELECT 1 FROM save_codes WHERE code = $1) RETURNING code`,
      [row.code, row.address, row.savePercent, row.spendPercent, row.appIds.join(","), row.catchUpEvery, row.catchUpFrom, row.tzOffsetMinutes, row.createdAt, row.updatedAt],
    );
  }
  async updateRule(c: string, rule: Pick<SaveCodeRow, "savePercent" | "spendPercent" | "appIds" | "catchUpEvery" | "catchUpFrom" | "tzOffsetMinutes">, at: number) {
    await this.pool.query(
      `UPDATE save_codes SET save_percent = $2, spend_percent = $3, app_ids = $4, catchup_every = $5, catchup_from = $6, tz_offset = $7, updated_at = $8 WHERE code = $1`,
      [c, rule.savePercent, rule.spendPercent, rule.appIds.join(","), rule.catchUpEvery, rule.catchUpFrom, rule.tzOffsetMinutes, at],
    );
  }
  async revoke(c: string, at: number) {
    await this.pool.query(`UPDATE save_codes SET revoked_at = $2, updated_at = $2 WHERE code = $1 AND revoked_at IS NULL`, [c, at]);
  }
  async useNonce(nonce: string, at: number) {
    await this.pool.query(`DELETE FROM save_nonces WHERE created_at < $1`, [at - NONCE_TTL_MS]);
    return this.insertOnce(
      `INSERT INTO save_nonces (nonce, created_at) SELECT $1::text, $2::bigint WHERE NOT EXISTS (SELECT 1 FROM save_nonces WHERE nonce = $1) RETURNING nonce`,
      [nonce, at],
    );
  }
  async addApp(a: SaveApp) {
    await this.pool.query(`INSERT INTO save_apps (id, name, key_hash, payout_addresses, created_at, pending, url, contact) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
      a.id, a.name, a.keyHash, a.payoutAddresses.join(","), a.createdAt, a.pending === true, a.url ?? null, a.contact ?? null,
    ]);
  }
  async appByKeyHash(keyHash: string) {
    const r = await this.pool.query<AppRow>(`SELECT * FROM save_apps WHERE key_hash = $1`, [keyHash]);
    return r.rows[0] ? app(r.rows[0]) : undefined;
  }
  async listApps() {
    const r = await this.pool.query<AppRow>(`SELECT * FROM save_apps ORDER BY created_at`);
    return r.rows.map(app);
  }
  async approveApp(id: string) {
    const r = await this.pool.query(`UPDATE save_apps SET pending = false WHERE id = $1`, [id]);
    return (r.rowCount ?? 0) > 0;
  }
  async removeApp(id: string) {
    const r = await this.pool.query(`DELETE FROM save_apps WHERE id = $1`, [id]);
    return (r.rowCount ?? 0) > 0;
  }
  async updateApp(id: string, fields: AppEdit) {
    const cols: [string, unknown][] = [];
    if (fields.name !== undefined) cols.push(["name", fields.name]);
    if (fields.url !== undefined) cols.push(["url", fields.url]);
    if (fields.contact !== undefined) cols.push(["contact", fields.contact]);
    if (fields.payoutAddresses !== undefined) cols.push(["payout_addresses", fields.payoutAddresses.join(",")]);
    if (cols.length === 0) return (await this.pool.query(`SELECT 1 FROM save_apps WHERE id = $1`, [id])).rows.length > 0;
    // Column names come from the fixed list above, never from input.
    const set = cols.map(([c], i) => `${c} = $${i + 2}`).join(", ");
    const r = await this.pool.query(`UPDATE save_apps SET ${set} WHERE id = $1`, [id, ...cols.map(([, v]) => v)]);
    return (r.rowCount ?? 0) > 0;
  }
  async setAppKey(id: string, keyHash: string) {
    const r = await this.pool.query(`UPDATE save_apps SET key_hash = $2 WHERE id = $1`, [id, keyHash]);
    return (r.rowCount ?? 0) > 0;
  }
  async appUsage() {
    // Added up here rather than in SQL, so amounts stay exact: luna is text, and sums can pass 2^53.
    const [receipts, codes] = await Promise.all([
      this.pool.query<Pick<ReceiptRow, "app_id" | "kind" | "source" | "luna" | "payout_id" | "address" | "created_at">>(
        `SELECT app_id, kind, source, luna, payout_id, address, created_at FROM save_receipts`,
      ),
      this.pool.query<{ app_ids: string }>(`SELECT app_ids FROM save_codes WHERE revoked_at IS NULL AND app_ids <> ''`),
    ]);
    return usageFrom(
      receipts.rows.map((r) => ({
        appId: r.app_id, kind: r.kind, source: r.source ?? "payout", luna: r.luna, payoutId: r.payout_id, address: r.address, createdAt: Number(r.created_at),
      })),
      codes.rows.map((c) => c.app_ids.split(",").filter(Boolean)),
    );
  }
  async addReceipt(x: SaveReceipt) {
    await this.pool.query(
      `INSERT INTO save_receipts (tx_hash, code, address, app_id, kind, source, luna, payout_id, block_number, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (tx_hash) DO NOTHING`,
      [x.txHash, x.code, x.address, x.appId, x.kind, x.source, x.luna, x.payoutId, x.blockNumber, x.createdAt],
    );
  }
  async receiptsForAddress(address: string, limit: number) {
    const r = await this.pool.query<ReceiptRow>(`SELECT * FROM save_receipts WHERE address = $1 ORDER BY created_at DESC LIMIT $2`, [address, limit]);
    return r.rows.map(receipt);
  }
  async addSplit(x: SaveSplitRow) {
    await this.insertOnce(
      `INSERT INTO save_splits (app_id, payout_id, code, address, wallet_luna, grow_luna, reason, save_percent, created_at)
       SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::integer, $9::bigint
       WHERE NOT EXISTS (SELECT 1 FROM save_splits WHERE app_id = $1 AND payout_id = $2) RETURNING payout_id`,
      [x.appId, x.payoutId, x.code, x.address, x.walletLuna, x.growLuna, x.reason, x.savePercent, x.createdAt],
    );
  }
  async splitsForAddress(address: string, limit: number) {
    const r = await this.pool.query<SplitRow>(`SELECT * FROM save_splits WHERE address = $1 ORDER BY created_at DESC LIMIT $2`, [address, limit]);
    return r.rows.map(split);
  }
  async lastCatchUp(address: string) {
    const r = await this.pool.query<CatchUpRow>(`SELECT * FROM save_catchups WHERE address = $1 ORDER BY period_to DESC LIMIT 1`, [address]);
    const x = r.rows[0];
    return x ? { address: x.address, periodTo: Number(x.period_to), txHash: x.tx_hash, luna: x.luna, createdAt: Number(x.created_at) } : undefined;
  }
  async addCatchUp(c: SaveCatchUp) {
    await this.pool.query(
      `INSERT INTO save_catchups (tx_hash, address, period_to, luna, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tx_hash) DO NOTHING`,
      [c.txHash, c.address, c.periodTo, c.luna, c.createdAt],
    );
  }
}
