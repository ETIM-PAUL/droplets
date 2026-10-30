import { CORRIDORS, type Corridor, type Order } from "@railkit/core";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { formatMoney } from "./format";
import { connectHost, type HostState } from "./host";
import { InviteGate } from "./InviteGate";
import { ReportProblem } from "./ReportProblem";
import { api, orderStore, PRACTICE, SIGNED_OUT } from "./send/engine";
import { OrderView } from "./send/OrderView";
import { SendHome } from "./send/SendHome";
import { Spike } from "./spike";
import { recipientBook, sessionToken, type SavedRecipient } from "./storage";
import "./styles.css";

type View = { name: "home" } | { name: "send"; start?: SavedRecipient } | { name: "order"; id: string };

const STATUS: Record<Order["state"], [string, "ok" | "bad" | ""]> = {
  awaiting_approval: ["Waiting for you", ""],
  submitting: ["Approving", ""],
  processing: ["On its way", ""],
  outcome_unknown: ["Checking", "bad"],
  completed: ["Arrived", "ok"],
  failed: ["Didn't go through", "bad"],
  cancelled: ["Cancelled", ""],
  expired: ["Expired", ""],
};

const book = recipientBook();

function App() {
  const [host, setHost] = useState<HostState | null>(null);
  const [corridors, setCorridors] = useState<Corridor[] | null>(null);
  const [view, setView] = useState<View>({ name: "home" });
  const [orders, setOrders] = useState<Order[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  // null while we ask the server whether the beta needs an invite.
  const [signedIn, setSignedIn] = useState<boolean | null>(() => (sessionToken.get() !== null ? true : null));

  useEffect(() => {
    if (signedIn !== null) return;
    // With the beta off the server hands out no token for any code, so the invite screen is skipped.
    api.session("").then(
      (s) => {
        if (s.token === null) {
          sessionToken.set("open");
          setSignedIn(true);
        } else setSignedIn(false);
      },
      () => setSignedIn(false),
    );
  }, [signedIn]);

  useEffect(() => {
    const out = () => setSignedIn(false);
    window.addEventListener(SIGNED_OUT, out);
    return () => window.removeEventListener(SIGNED_OUT, out);
  }, []);

  useEffect(() => {
    void connectHost().then(setHost);
    api.corridors().then(setCorridors, (e: Error) => {
      setCorridors([]);
      setLoadError(e.message);
    });
  }, []);

  useEffect(() => {
    if (view.name === "home") void orderStore.list().then(setOrders);
  }, [view]);

  // An order still in flight from last time: take the person straight back to it.
  useEffect(() => {
    const live = orders.find((o) => o.state === "submitting" || o.state === "processing" || o.state === "outcome_unknown");
    if (live && view.name === "home" && Date.now() - live.updatedAt < 6 * 3600_000) setView({ name: "order", id: live.id });
    // Only on first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders.length > 0]);

  if (host?.status === "outside-nimiq-pay") {
    return (
      <div className="screen">
        <h1 className="sentence">Errand runs inside Nimiq Pay.</h1>
        <p>Open Nimiq Pay, go to Mini Apps, and open Errand from there.</p>
      </div>
    );
  }

  if (signedIn === null) return <div className="screen"><p className="hint">Opening Errand…</p></div>;
  if (!signedIn) return <InviteGate onIn={() => setSignedIn(true)} />;

  const enabled = new Set((corridors ?? []).map((c) => c.id));

  if (view.name === "send" && corridors) {
    return <SendHome enabled={corridors} start={view.start} onDone={(id) => setView({ name: "order", id })} onCancel={() => setView({ name: "home" })} />;
  }
  if (view.name === "order") {
    return (
      <OrderView
        orderId={view.id}
        enabled={enabled}
        onHome={() => setView({ name: "home" })}
        onRetry={(o) => {
          const d = o.quote.intent.destination;
          if (d.kind !== "fiat-payout") return setView({ name: "home" });
          setView({ name: "send", start: { corridor: d.corridor, recipient: d.recipient, lastAmount: o.quote.receive.amount, usedAt: Date.now() } });
        }}
      />
    );
  }

  const saved = book.list().filter((s) => enabled.has(s.corridor));

  return (
    <div className="screen">
      <div className="topbar">
        <span>Errand</span>
        {host?.status === "ready" && <span className="balance">{formatMoney(host.balanceNim, "NIM")}</span>}
      </div>

      <h1 className="sentence">Send money home in one sentence.</h1>
      {host?.status === "error" && <p className="alert" role="alert">{host.message}</p>}
      {loadError && <p className="alert" role="alert">{loadError}</p>}

      <div className="grow">
        <button className="primary" disabled={!corridors || corridors.length === 0} onClick={() => setView({ name: "send" })}>
          {corridors ? "Send money" : "Loading…"}
        </button>

        {saved.length > 0 && (
          <section>
            <h2 className="section-title">Send again</h2>
            <ul className="list">
              {saved.map((s) => {
                const r = s.recipient;
                const name = r.type === "mobile-money" ? r.name : r.accountName;
                return (
                  <li key={`${s.corridor}:${name}`}>
                    <button type="button" onClick={() => setView({ name: "send", start: s })}>
                      <span>{name}</span>
                      <span className="status">{formatMoney(s.lastAmount, CORRIDORS[s.corridor].currency)} on {CORRIDORS[s.corridor].label.split(": ")[1]}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {orders.length > 0 && (
          <section>
            <h2 className="section-title">Recent</h2>
            <ul className="list">
              {orders.slice(0, 8).map((o) => {
                const d = o.quote.intent.destination;
                const who = d.kind === "fiat-payout" ? (d.recipient.type === "mobile-money" ? d.recipient.name : d.recipient.accountName) : "Payment";
                const [label, tone] = STATUS[o.state];
                return (
                  <li key={o.id}>
                    <button type="button" onClick={() => setView({ name: "order", id: o.id })}>
                      <span>{formatMoney(o.quote.receive.amount, o.quote.receive.currency)} to {who}</span>
                      <span className={`status ${tone}`}>{label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        <div className="grow" />
        <ReportProblem />
      </div>
    </div>
  );
}

/** Shown on every screen in practice mode, so nobody mistakes a rehearsal for a real payment. */
function PracticeBanner() {
  return PRACTICE ? <p className="practice" role="status">Practice mode: no real money moves.</p> : null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PracticeBanner />
    {location.hash === "#spike" ? <Spike /> : <App />}
  </StrictMode>,
);
