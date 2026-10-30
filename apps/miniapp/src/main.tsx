import { CORRIDORS, destinationLabel, type Corridor, type Order } from "@railkit/core";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { formatMoney } from "./format";
import { connectHost, type HostState } from "./host";
import { InviteGate } from "./InviteGate";
import { ReportProblem } from "./ReportProblem";
import { api, orderStore, PRACTICE, SIGNED_OUT } from "./send/engine";
import { Chat } from "./send/Chat";
import { OrderView } from "./send/OrderView";
import { Scan } from "./send/Scan";
import { SendHome } from "./send/SendHome";
import { Spike } from "./spike";
import { recipientBook, sessionToken, type SavedRecipient } from "./storage";
import "./styles.css";

type View =
  | { name: "home" }
  | { name: "chat"; text: string }
  | { name: "scan" }
  | { name: "send"; start?: SavedRecipient; autoQuote?: boolean }
  | { name: "order"; id: string };

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

/** The developer test page can make real payments, so it only exists in dev or when VITE_TEST_PAGE=true. */
const TEST_PAGE = import.meta.env.DEV || import.meta.env.VITE_TEST_PAGE === "true";

function App() {
  const [host, setHost] = useState<HostState | null>(null);
  const [corridors, setCorridors] = useState<Corridor[] | null>(null);
  const [view, setView] = useState<View>({ name: "home" });
  const [orders, setOrders] = useState<Order[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sentence, setSentence] = useState("");
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

  // Nimiq Pay still connecting: check again every few seconds until the balance comes through.
  useEffect(() => {
    if (host?.status !== "ready" || host.balanceNim !== null) return;
    const t = setTimeout(() => void connectHost().then(setHost), 4_000);
    return () => clearTimeout(t);
  }, [host]);

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
    return <SendHome enabled={corridors} start={view.start} autoQuote={view.autoQuote} onDone={(id) => setView({ name: "order", id })} onCancel={() => setView({ name: "home" })} />;
  }
  if (view.name === "chat" && corridors) {
    return (
      <Chat
        first={view.text}
        enabled={corridors}
        onReady={(start) => setView({ name: "send", start, autoQuote: true })}
        onCancel={() => setView({ name: "home" })}
        onManual={() => setView({ name: "send" })}
      />
    );
  }
  if (view.name === "scan") {
    return <Scan enabled={enabled} onDone={(id) => setView({ name: "order", id })} onCancel={() => setView({ name: "home" })} />;
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
        {host?.status === "ready" &&
          (host.balanceNim === null
            ? <span>Connecting to the Nimiq network…</span>
            : <span className="balance">{formatMoney(host.balanceNim, "NIM")}</span>)}
      </div>

      <h1 className="sentence">Send money home in one sentence.</h1>
      {host?.status === "error" && <p className="alert" role="alert">{host.message}</p>}
      {loadError && <p className="alert" role="alert">{loadError}</p>}

      <div className="grow">
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (!sentence.trim() || !corridors?.length) return;
            setView({ name: "chat", text: sentence.trim() });
            setSentence("");
          }}
        >
          <input
            aria-label="What would you like to send?"
            placeholder={corridors?.some((c) => c.id === "ng-bank") ? "Send ₦5,000 to 0123456789 GTBank" : "Send 2,500 KES to Mary on M-Pesa 0712 345 678"}
            value={sentence}
            onChange={(e) => setSentence(e.target.value)}
            maxLength={300}
            autoComplete="off"
          />
          <button className="primary" disabled={!corridors || corridors.length === 0 || !sentence.trim()}>Go</button>
        </form>
        <button className="secondary" disabled={!corridors || corridors.length === 0} onClick={() => setView({ name: "send" })}>
          {corridors ? "Fill it in step by step" : "Loading…"}
        </button>
        <button className="secondary" onClick={() => setView({ name: "scan" })}>Pay a code (QR or Lightning)</button>

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
                const who = destinationLabel(d);
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
        {TEST_PAGE && <a className="hint" href="#spike">Test page (developers only)</a>}
      </div>
    </div>
  );
}

/** Shown on every screen in practice mode, so nobody mistakes a rehearsal for a real payment. */
function PracticeBanner() {
  return PRACTICE ? <p className="practice" role="status">Practice mode: no real money moves.</p> : null;
}

function Root() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return (
    <>
      <PracticeBanner />
      {TEST_PAGE && hash === "#spike" ? <Spike /> : <App />}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
