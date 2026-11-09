import type { PrizeMe, SaveActivity } from "@railkit/client";
import { lunaToNimString, parseNimiqAddress } from "@railkit/core";
import { useEffect, useState } from "react";
import { api } from "../api";
import { formatMoney } from "../format";
import { Icon, PageHead, type IconName } from "../ui";

const nim = (luna: string | bigint) => formatMoney(lunaToNimString(BigInt(luna)), "NIM");
const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const DAY = 86_400_000;
/** "Today", "Yesterday", or the date: the heading over each day's rows. */
function dayHeading(ms: number): string {
  const start = (t: number) => new Date(new Date(t).toDateString()).getTime();
  const diff = Math.round((start(Date.now()) - start(ms)) / DAY);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return new Date(ms).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

/** Why a payment went all to the wallet, when the user's rule asked for some savings. */
const ALL_TO_WALLET: Record<NonNullable<SaveActivity["payments"][number]["reason"]>, string> = {
  "no-stake": "All to your wallet: your savings weren't open",
  "validator-gone": "All to your wallet: your validator had closed",
  "below-minimum": "All to your wallet: your savings were under the 100 NIM minimum",
};

const GROW: Record<NonNullable<SaveActivity["grow"]>[number]["kind"], { title: string; icon: IconName; sign: string }> = {
  opened: { title: "Opened your savings", icon: "drop", sign: "+" },
  added: { title: "Added to savings", icon: "plus", sign: "+" },
  "withdrawal-started": { title: "Started a withdrawal", icon: "clock", sign: "" },
  withdrawn: { title: "Withdrew to your wallet", icon: "send", sign: "−" },
};

interface Row {
  key: string;
  at: number;
  icon: IconName;
  /** saved: into savings. in: to the wallet. prize: the draw. */
  tone?: "saved" | "in" | "prize";
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
        key: `spend:${p.app}:${p.payoutId}`, at: p.at, icon: grow > 0n ? "drop" : "down", tone: grow > 0n ? "saved" : "in", amount: `+${nim(grow + wallet)}`,
        title: p.app,
        detail: grow > 0n ? "Saved on top when you paid" : "Your saving, back to your wallet: your savings couldn't take it",
      });
      continue;
    }
    rows.push({
      key: `pay:${p.app}:${p.payoutId}`, at: p.at, icon: "down", tone: "in", title: `${p.app} paid you`, amount: `+${nim(grow + wallet)}`,
      detail: grow > 0n ? `${nim(grow)} to savings, ${nim(wallet)} to your wallet` : p.reason ? ALL_TO_WALLET[p.reason] : "All to your wallet",
    });
  }
  for (const g of save?.grow ?? []) {
    const k = GROW[g.kind];
    rows.push({
      key: `grow:${g.txHash}`, at: g.at, icon: k.icon, tone: g.kind === "withdrawn" ? undefined : "saved", title: k.title, amount: g.luna === "0" ? undefined : `${k.sign}${nim(g.luna)}`,
      detail: g.kind === "withdrawal-started" ? "Ready to finish in 12 to 24 hours" : "From your own account",
      status: g.ok ? undefined : ["Didn't go through", "bad"],
    });
  }
  for (const w of wins) {
    rows.push({
      key: `prize:${w.week}`, at: w.drawAt, icon: "gift", tone: "prize", title: "Won the weekly draw", amount: `+${nim(w.prizeLuna)}`,
      detail: w.paid ? "Paid to you" : "Paying out soon",
    });
  }
  rows.sort((a, b) => b.at - a.at);
  // One list per day, under its heading.
  const days: { heading: string; rows: Row[] }[] = [];
  for (const r of rows) {
    const heading = dayHeading(r.at);
    if (days.at(-1)?.heading === heading) days.at(-1)!.rows.push(r);
    else days.push({ heading, rows: [r] });
  }

  return (
    <>
      <PageHead title="Activity" />
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
          {save.grow === null && <p className="note">Your own savings transactions couldn't be loaded just now. Try again in a minute.</p>}
          {rows.length === 0 ? (
            <p className="empty">Nothing yet. What apps pay you or save for you, and what you put in or take out of your savings, show up here.</p>
          ) : (
            days.map((d) => (
              <section key={d.heading} className="section">
                <h2 className="day-heading">{d.heading}</h2>
                <ul className="list">
                  {d.rows.map((r) => (
                    <li key={r.key}>
                      <div className="row">
                        <span className={`row-icon${r.tone ? ` ${r.tone}` : ""}`}><Icon name={r.icon} size={20} /></span>
                        <span className="row-main">
                          <strong>{r.title}</strong>
                          <span>{r.detail}</span>
                        </span>
                        <span className="row-end">
                          {r.amount && <span className="row-amount">{r.amount}</span>}
                          {r.status ? <span className={`status ${r.status[1]}`}>{r.status[0]}</span> : <span className="row-time">{time(r.at)}</span>}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </>
      )}
    </>
  );
}
