import { init, requestDeviceIdentifier } from "@nimiq/mini-app-sdk";
import { ApiError, type PrizeMe } from "@railkit/client";
import { formatDrawMessage, lunaToNimString, parseNimiqAddress } from "@railkit/core";
import { createNimiqSaver } from "@railkit/wallet-nimiq";
import { useEffect, useState } from "react";
import { api } from "../api";
import { formatMoney } from "../format";
import { Icon } from "../ui";
import { errorText, newNonce } from "./SaveHome";

type Day = NonNullable<PrizeMe["week"]>["days"][number];

const nim = (luna: string | bigint) => formatMoney(lunaToNimString(BigInt(luna)), "NIM");
/** "Sunday 11:59 PM", in the phone's own time zone. */
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" });
const weekday = (day: string, style: "narrow" | "long") => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: style, timeZone: "UTC" });
const weekOf = (week: string) => new Date(`${week}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
const DAY_LABEL: Record<Day["status"], string> = { kept: "kept", missed: "missed", today: "today, so far", ahead: "still to come" };

/** The weekly draw on Savings: join, then see each day of the week kept or missed, and how the latest draw went. */
export function DrawCard({ address }: { address: string | null }) {
  const [me, setMe] = useState<PrizeMe | null>(null);
  const [off, setOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const self = address ? parseNimiqAddress(address) : null;

  const load = async () => {
    if (!self?.ok) return;
    try {
      setMe(await api.prizeMe(self.value));
    } catch (e) {
      // Switched off on this server: no card at all.
      if (e instanceof ApiError && e.status === 503 && /switched off/.test(e.message)) setOff(true);
      else setError(errorText(e));
    }
  };
  useEffect(() => {
    void load();
    // Reload when the account changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // ---- Tap handlers. Each opens Nimiq Pay's own dialog; the signing guard checks they stay that way.

  async function joinDraw() {
    if (!self?.ok || !me) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      // One entry per phone. Nimiq Pay asks the person before it shares this.
      const device = await requestDeviceIdentifier({ reason: "The weekly draw allows one entry per phone." }).catch(() => {
        throw new Error("Errand needs Nimiq Pay to recognise this phone, so each phone enters once. If Nimiq Pay didn't ask you, update it and try again.");
      });
      const message = formatDrawMessage({ action: "join", address: self.value, time: new Date().toISOString(), nonce: newNonce() });
      const saver = createNimiqSaver(await init({ timeout: 5_000 }));
      await api.prizeJoin({ message, ...(await saver.signRule(message)), device });
      await load();
      setInfo(`You're in. Keep at least ${nim(me.rules.minLuna)} in Grow on ${me.rules.daysNeeded} days of the week.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function leaveDraw() {
    if (!self?.ok) return;
    setBusy(true);
    setError(null);
    try {
      const message = formatDrawMessage({ action: "leave", address: self.value, time: new Date().toISOString(), nonce: newNonce() });
      const saver = createNimiqSaver(await init({ timeout: 5_000 }));
      await api.prizeJoin({ message, ...(await saver.signRule(message)) });
      setConfirmLeave(false);
      await load();
      setInfo("You've left the draw. Your Grow savings stay where they are.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (off || !self?.ok) return null;
  if (!me) return error ? <p className="alert" role="alert">{error}</p> : null;

  const r = me.rules;
  const min = BigInt(r.minLuna);
  const messages = (
    <>
      {error && <p className="alert" role="alert">{error}</p>}
      {info && <p className="note" role="status">{info}</p>}
    </>
  );
  const title = (
    <div className="draw-title">
      <span className="draw-badge"><Icon name="spark" size={18} /></span>
      <strong>Win {nim(r.prizeLuna)} every Sunday</strong>
    </div>
  );

  if (!me.joined || !me.week) {
    return (
      <section className="card draw-card" aria-label="Weekly draw">
        {title}
        <p className="hint">
          Keep at least {nim(r.minLuna)} in Grow on {r.daysNeeded} of the 7 days and you're in that Sunday's draw. Keep more for more tickets: every 10 times as much adds one, up to {r.maxTickets}.
        </p>
        {messages}
        <button type="button" className="primary" disabled={busy} onClick={() => void joinDraw()}>{busy ? "Opening Nimiq Pay…" : "Join the draw"}</button>
        <p className="note">Nimiq Pay asks to recognise this phone, so each phone enters once, and asks you to sign. Both are free.</p>
      </section>
    );
  }

  const w = me.week;
  // Today counts as missed as soon as it has dipped under the minimum.
  const shown = w.days.map((d) => ({ ...d, status: d.status === "today" && d.lowLuna !== null && BigInt(d.lowLuna) < min ? ("missed" as const) : d.status }));
  const ahead = shown.filter((d) => d.status === "ahead").length;
  const still = r.daysNeeded - w.daysKept;
  const status = w.tooManyTransactions
    ? "This account has too many transactions this week for Errand to check, so it can't enter this week's draw."
    : w.tickets > 0
      ? `You're in, with ${w.tickets} ticket${w.tickets === 1 ? "" : "s"} for keeping ${nim(w.keptLuna)}.`
      : still <= ahead
        ? `${w.daysKept} of ${r.daysNeeded} days so far. Keep at least ${nim(r.minLuna)} in Grow for ${still} more day${still === 1 ? "" : "s"} to get in.`
        : `This week can't reach ${r.daysNeeded} days any more. Next week starts on Monday.`;
  const last = me.lastDraw;

  return (
    <section className="card draw-card" aria-label="Weekly draw">
      {title}
      <ol className="week-strip" aria-label="This week">
        {shown.map((d) => (
          <li key={d.day} className={`day ${d.status}`} aria-label={`${weekday(d.day, "long")}: ${DAY_LABEL[d.status]}`}>
            <span aria-hidden="true">{weekday(d.day, "narrow")}</span>
            {d.status === "kept" ? <Icon name="check" size={14} /> : d.status === "missed" ? <Icon name="close" size={14} /> : null}
          </li>
        ))}
      </ol>
      <p className="draw-status">{status}</p>
      <p className="hint">The draw is {when(w.drawAt)}. The prize goes straight into the winner's Grow.</p>
      {last && (
        <p className="note">
          {last.youWon
            ? `You won the draw for the week of ${weekOf(last.week)}! ${nim(last.prizeLuna)} ${last.paid ? "has been paid to you" : "is on its way to you"}.`
            : last.winner
              ? `Week of ${weekOf(last.week)}: ${last.entries} saver${last.entries === 1 ? "" : "s"} with ${last.totalTickets} ticket${last.totalTickets === 1 ? "" : "s"}. ${last.winner} won, picked with Nimiq block ${last.blockNumber.toLocaleString()}.`
              : `Nobody qualified in the week of ${weekOf(last.week)}.`}
        </p>
      )}
      {messages}
      {confirmLeave ? (
        <div className="row-buttons">
          <button type="button" className="secondary" onClick={() => setConfirmLeave(false)}>Stay in</button>
          <button type="button" className="primary" disabled={busy} onClick={() => void leaveDraw()}>{busy ? "Opening Nimiq Pay…" : "Leave"}</button>
        </div>
      ) : (
        <button type="button" className="text-button" onClick={() => setConfirmLeave(true)}>Leave the draw</button>
      )}
    </section>
  );
}
