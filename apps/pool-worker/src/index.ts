// The Steady/Boost pool's worker: the only process that holds the pool's key. It is not reachable from the
// internet. Every minute: turn payments into deposits, settle when a slot comes round, and pay out.
import { nimPriceSources } from "@railkit/adapters/server";
import { createNimiqRpc } from "@railkit/core";
import { payPending, PgPoolStore, poolConfigFromEnv, settleIfDue, watchDeposits } from "@railkit/pool";
import { createSavePayer, type PayoutLog, type PayoutRecord } from "@railkit/save/payer";
import pg from "pg";

const log = (msg: string, data?: Record<string, unknown>) => console.log(JSON.stringify({ msg, ...data }));

const cfg = poolConfigFromEnv(process.env);
if (!cfg) {
  log("pool worker off: POOL_ENABLED isn't true");
  process.exit(0);
}
if (!process.env.DATABASE_URL) throw new Error("The pool worker needs DATABASE_URL: the pool's books must survive a restart");
const hexKey = (process.env.POOL_KEY ?? "").trim();
if (!/^[0-9a-f]{64}$/i.test(hexKey)) throw new Error("POOL_KEY must be the pool wallet's 32-byte key, as hex");

const Nimiq = await import("@nimiq/core");
const keyPair = Nimiq.KeyPair.derive(Nimiq.PrivateKey.fromHex(hexKey));
if (keyPair.toAddress().toUserFriendlyAddress() !== cfg.poolAddress) throw new Error("POOL_KEY doesn't belong to POOL_ADDRESS");

const store = new PgPoolStore(new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 }));
await store.migrate();
const rpc = createNimiqRpc({ url: process.env.NIMIQ_RPC_URL || (cfg.network === "testnet" ? "https://rpc.testnet.nimiqwatch.com" : "https://rpc.nimiqwatch.com") });

/** The payer's log lives on each payout row, so a restart resends exactly what was signed before. */
const payoutLog: PayoutLog = {
  async get(id) {
    const p = await store.getPayout(id);
    if (!p?.record) return undefined;
    const r = JSON.parse(p.record) as Omit<PayoutRecord, "txs"> & { txs: (Omit<PayoutRecord["txs"][number], "luna"> & { luna: string })[] };
    return { ...r, txs: r.txs.map((t) => ({ ...t, luna: BigInt(t.luna) })) };
  },
  async put(r) {
    await store.updatePayout(r.payoutId, { record: JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) });
  },
};
const payer = createSavePayer({ rpc, nimiq: Nimiq, keyPair, network: cfg.network === "mainnet" ? "main" : "test", log: payoutLog });
// A node on the other network takes the pool's payouts, answers with their hashes, and never lands them. Stop here instead.
await payer.checkNetwork();

const alertUrl = process.env.ALERT_WEBHOOK_URL;
const alert = async (text: string) => {
  log("pool alert", { text });
  if (alertUrl) await fetch(alertUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
};

const prices = nimPriceSources();
let running = false;
async function tick() {
  if (running) return;
  running = true;
  const now = Date.now();
  try {
    const d = await watchDeposits({ store, rpc, cfg: cfg!, now, alert });
    if (d.queued || d.unmatched || d.expired) log("pool deposits", d);
    const s = await settleIfDue({ store, prices, cfg: cfg!, now, alert, log });
    if (s.settled) log("pool settlement", { seq: s.seq });
    const p = await payPending({ store, rpc, pay: (x) => payer.pay(x), now, alert });
    if (p.sent || p.confirmed || p.failed) log("pool payouts", p);
  } catch (e) {
    log("pool worker round failed", { error: String(e) });
  } finally {
    running = false;
  }
}

log("pool worker running", { network: cfg.network, pool: cfg.poolAddress, settleEveryMinutes: cfg.settleEveryMinutes });
await tick();
setInterval(() => void tick(), 60_000);
