import type { PrizeMe, SaveActivity } from "@railkit/client";
import { lunaToNimString, parseNimiqAddress } from "@railkit/core";
import { useEffect, useState } from "react";
import { api } from "../api";
import { formatMoney } from "../format";
import { Icon, type IconName } from "../ui";

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

/** The savings history, newest first: what apps paid or saved for the user, Grow, and weekly draw wins. */
export function ActivityTab({ address }: { address: string | null }) {
  const [save, setSave] = useState<SaveActivity | null>(null);
  const [wins, setWins] = useState<PrizeMe["wins"]>([]);
  const [error, setError] = useState<string | null>(null);

  const self = address ? parseNimiqAddress(address) : null;
  const load = async () => {
    if (!self?.ok) return;
    setError(null);
    try {
      // Draw wins are a bonus: if they can't load (or the draw is off), the rest still shows.
      const [s, p] = await Promise.all([api.saveActivity(self.value), api.prizeMe(self.value).catch(() => null)]);
      setSave(s);
      setWins(p?.wins ?? []);
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
    if (p.source === "spend") {
      // The part saved on top when the user paid the app; back to the wallet if Grow couldn't take it by then.
      rows.push({
        key: `spend:${p.app}:${p.payoutId}`, at: p.at, icon: grow > 0n ? "jar" : "down", incoming: true, amount: `+${nim(grow + wallet)}`,
        title: grow > 0n ? `Saved when you paid ${p.app}` : `${p.app} gave back your saving`,
        detail: grow > 0n ? "Into Grow, on top of what you paid" : "To your wallet: Grow couldn't take it",
      });
      continue;
    }
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
  for (const w of wins) {
    rows.push({
      key: `prize:${w.week}`, at: w.drawAt, icon: "spark", incoming: true, title: "Won the weekly draw", amount: `+${nim(w.prizeLuna)}`,
      detail: w.paid ? "Paid to you" : "Paying out soon",
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
            <p className="empty">Nothing yet. What apps pay you or save for you, and what you put in or take out of your savings, show up here.</p>
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
