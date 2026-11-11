import { init } from "@nimiq/mini-app-sdk";
import type { SaveIntent } from "@railkit/agent";
import type { SaveApp, SaveMe } from "@railkit/client";
import { formatSaveMessage, lunaToNimString, parseNimiqAddress } from "@railkit/core";
import { createNimiqSaver } from "@railkit/wallet-nimiq";
import { useEffect, useState } from "react";
import { api } from "../api";
import { formatMoney } from "../format";
import { plan } from "./confirm-plan";
import { errorText, newNonce } from "./SaveHome";

const nim = (luna: bigint) => formatMoney(lunaToNimString(luna), "NIM");
const tzOffset = () => -new Date().getTimezoneOffset();

interface Props {
  intent: SaveIntent;
  address: string | null;
  /** The change went to Nimiq Pay and was approved: what to say in the chat. */
  onDone: (text: string) => void;
  /** Open the full screen for it instead, filled in. */
  onForm: () => void;
  onCancel: () => void;
}

/**
 * The chat's change, ready to confirm: the exact values, a Confirm button that opens Nimiq Pay's approval, and a way
 * to the full form. The chat itself never touches the wallet; only this card's button does, when the user taps it.
 */
export function ConfirmCard({ intent, address, onDone, onForm, onCancel }: Props) {
  const [me, setMe] = useState<SaveMe | null>(null);
  const [apps, setApps] = useState<SaveApp[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const self = address ? parseNimiqAddress(address) : null;

  useEffect(() => {
    if (!self?.ok) return;
    Promise.all([api.saveMe(self.value, true), api.saveApps()]).then(
      ([m, a]) => {
        setMe(m);
        setApps(a);
      },
      (e) => setError(errorText(e)),
    );
    // Once, for this change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!self?.ok) return <p className="note">Open Droplets inside Nimiq Pay to make changes.</p>;
  if (!me || !apps) return error ? <p className="alert" role="alert">{error}</p> : <p className="note" role="status">Checking your savings…</p>;
  const p = plan(intent, me);

  // ---- The tap handler. It opens Nimiq Pay's own dialog; the signing guard checks it stays that way.

  async function confirmChange() {
    if (!self?.ok || !me || p.kind === "form") return;
    setBusy(true);
    setError(null);
    try {
      const saver = createNimiqSaver(await init({ timeout: 5_000 }));
      if (p.kind === "rule" || p.kind === "revoke") {
        // Rules are signed whole: keep the user's other rules, and only the apps Droplets still knows.
        const known = new Set(apps!.map((a) => a.name));
        const message = p.kind === "revoke"
          ? formatSaveMessage({ action: "revoke", address: self.value, time: new Date().toISOString(), nonce: newNonce() })
          : formatSaveMessage({
              action: "set", address: self.value, savePercent: p.savePercent, spendPercent: me!.spendPercent ?? 0,
              ...(me!.allApps ? { allApps: true } : { apps: me!.apps.map((a) => a.name).filter((n) => known.has(n)) }), catchUp: me!.catchUp ?? "weekly",
              time: new Date().toISOString(), nonce: newNonce(),
            });
        await api.saveRule({ message, ...(await saver.signRule(message)), tzOffsetMinutes: tzOffset() });
        onDone(p.kind === "revoke" ? "Done. Save code off; apps pay your wallet." : `Done. ${p.savePercent}% of what apps pay you now goes to savings.`);
      } else if (p.kind === "add") {
        await saver.addToGrow(p.luna);
        onDone(`Done. ${nim(p.luna)} is on its way to your savings.`);
      } else {
        await saver.startWithdrawal(p.newActive);
        onDone(`Done. Your withdrawal of ${nim(p.luna)} has started. It's ready in 12 to 24 hours; finish it on Home then.`);
      }
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  if (p.kind === "form") {
    return (
      <div className="confirm-card">
        <strong className="card-title">This needs the form</strong>
        {p.why && <p className="hint">{p.why}</p>}
        <button type="button" className="secondary" onClick={onForm}>Open the form</button>
      </div>
    );
  }
  return (
    <div className="confirm-card" aria-label="Confirm this change">
      <strong className="card-title">{p.title}</strong>
      <p className="hint">{p.detail}</p>
      {error && <p className="alert" role="alert">{error}</p>}
      <button type="button" className="primary" disabled={busy} onClick={() => void confirmChange()}>{busy ? "Opening Nimiq Pay…" : "Confirm"}</button>
      <div className="confirm-links">
        <button type="button" className="text-button" disabled={busy} onClick={onForm}>Change it in the form</button>
        <button type="button" className="text-button" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      <p className="note">Nothing changes until you approve in Nimiq Pay.</p>
    </div>
  );
}
