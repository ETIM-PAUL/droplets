import type { PoolMe, SaveActivity } from "@railkit/client";
import { lunaToNimString, parseNimiqAddress } from "@railkit/core";
import { useEffect, useState } from "react";
import { api } from "../api";
import { formatMoney } from "../format";
import { Icon, type IconName } from "../ui";
import { ORDER_STATUS, PAYOUT_STATUS, SIDE_NAME } from "./PoolHome";

const nim = (luna: string | bigint) => formatMoney(lunaToNimString(BigInt(luna)), "NIM");
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** Why a payment went all to the wallet, when the user's rule asked for some savings. */
const ALL_TO_WALLET: Record<NonNullable<SaveActivity["payments"][number]["reason"]>, string> = {
  "no-stake": "All to your wallet: Grow wasn't open",
  "validator-gone": "All to your wallet: your validator had closed",
  "below-minimum": "All to your wallet: Grow was under Nimiq's 100 NIM minimum",
};

const GROW: Record<NonNullable<SaveActivity["grow"]>[number]["kind"], { title: string; icon: IconName; sign: string }> = {
  opened: { title: "Opened Grow", icon: "jar", sign: "+" },
  added: { title: "Added to Grow", icon: "plus", sign: "+" },
  "withdrawal-started": { title: "Started a withdrawal from Grow", icon: "clock", sign: "" },
  withdrawn: { title: "Withdrew from Grow to your wallet", icon: "send", sign: "−" },
};

interface Row {
  key: string;
  at: number;
  icon: IconName;
  incoming?: boolean;
  title: string;
  detail: string;
  amount?: string;
  status?: [string, "ok" | "bad" | ""];
}

/** The savings history, newest first: payments in with the save code, Grow, and Steady and Boost orders. */
export function ActivityTab({ address, pool }: { address: string | null; pool: boolean }) {
  const [save, setSave] = useState<SaveActivity | null>(null);
  const [poolMe, setPoolMe] = useState<PoolMe | null>(null);
  const [error, setError] = useState<string | null>(null);

  const self = address ? parseNimiqAddress(address) : null;
  const load = async () => {
    if (!self?.ok) return;
    setError(null);
    try {
      // The pool's part is a bonus: if it can't load, the rest still shows.
      const [s, p] = await Promise.all([api.saveActivity(self.value), pool ? api.poolMe(self.value).catch(() => null) : null]);
      setSave(s);
      setPoolMe(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
    }
  };
  useEffect(() => {
    void load();
    // Reload when the account changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  const rows: Row[] = [];
  for (const p of save?.payments ?? []) {
    const grow = BigInt(p.growLuna);
    const wallet = BigInt(p.walletLuna);
    rows.push({
      key: `pay:${p.app}:${p.payoutId}`, at: p.at, icon: "down", incoming: true, title: `${p.app} paid you`, amount: `+${nim(grow + wallet)}`,
      detail: grow > 0n ? `${nim(grow)} to Grow, ${nim(wallet)} to your wallet` : p.reason ? ALL_TO_WALLET[p.reason] : "All to your wallet",
    });
  }
  for (const g of save?.grow ?? []) {
    const k = GROW[g.kind];
    rows.push({
      key: `grow:${g.txHash}`, at: g.at, icon: k.icon, title: k.title, amount: g.luna === "0" ? undefined : `${k.sign}${nim(g.luna)}`,
      detail: g.kind === "withdrawal-started" ? "Ready to finish in 12 to 24 hours" : "From your own account",
      status: g.ok ? undefined : ["Didn't go through", "bad"],
    });
  }
  for (const o of poolMe?.orders ?? []) {
    const payout = poolMe!.payouts.find((p) => p.orderId === o.id);
    const deposit = o.kind === "deposit";
    rows.push({
      key: `pool:${o.id}`, at: o.createdAt, icon: deposit ? "plus" : "send",
      title: deposit ? `Added to ${SIDE_NAME[o.side]}` : `Withdrawal from ${SIDE_NAME[o.side]}`,
      amount: deposit ? (o.nim ? `+${formatMoney(o.nim, "NIM")}` : undefined) : o.all ? "All" : o.usd ? `−$${o.usd}` : o.nim ? `−${formatMoney(o.nim, "NIM")}` : undefined,
      detail: payout ? `${PAYOUT_STATUS[payout.status]}, ${formatMoney(payout.nim, "NIM")}` : ORDER_STATUS[o.status],
    });
  }
  rows.sort((a, b) => b.at - a.at);

  return (
    <>
      <header className="home-head"><h1>Activity</h1></header>
      {!self?.ok ? (
        <p className="hint">Connecting to Nimiq Pay…</p>
      ) : error ? (
        <>
          <p className="alert" role="alert">{error}</p>
          <button type="button" className="secondary" onClick={() => void load()}>Try again</button>
        </>
      ) : !save ? (
        <p className="hint">Loading your activity…</p>
      ) : (
        <>
          {save.grow === null && <p className="note">Your Grow transactions couldn't be loaded just now. Try again in a minute.</p>}
          {rows.length === 0 ? (
            <p className="empty">Nothing yet. Payments in with your save code, and what you put in or take out of your savings, show up here.</p>
          ) : (
            <ul className="list">
              {rows.map((r) => (
                <li key={r.key}>
                  <div className="row">
                    <span className={`row-icon${r.incoming ? " in" : ""}`}><Icon name={r.icon} size={20} /></span>
                    <span className="row-main">
                      <strong>{r.title}</strong>
                      <span>{day(r.at)} · {r.detail}</span>
                    </span>
                    <span className="row-end">
                      {r.amount && <span className="row-amount">{r.amount}</span>}
                      {r.status && <span className={`status ${r.status[1]}`}>{r.status[0]}</span>}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
