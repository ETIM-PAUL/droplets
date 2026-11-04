import type { TopupIntent } from "@railkit/agent";
import { CORRIDORS, destinationLabel, type Corridor, type Order } from "@railkit/core";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { formatMoney } from "./format";
import { connectHost, type HostState } from "./host";
import { InviteGate } from "./InviteGate";
import { ReportProblem } from "./ReportProblem";
import { Chat } from "./send/Chat";
import { api, orderStore, PRACTICE, SIGNED_OUT } from "./send/engine";
import { OrderView } from "./send/OrderView";
import { Scan } from "./send/Scan";
import { SendHome } from "./send/SendHome";
import { SaveHome } from "./save/SaveHome";
import { Spike } from "./spike";
import { recipientBook, sessionToken, topupBook, type LocalTopup, type SavedRecipient } from "./storage";
import { AddMoney } from "./topup/AddMoney";
import { Avatar, ChatInput, Hexagon, Icon, TabBar, type IconName, type Tab } from "./ui";
import "./styles.css";

type View =
  | { name: "tabs" }
  | { name: "chat"; text: string }
  | { name: "scan" }
  | { name: "topup"; prefill?: TopupIntent; orderId?: string }
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

const TOPUP_STATUS: Record<string, [string, "ok" | "bad" | ""]> = {
  awaiting_payment: ["Waiting for payment", ""],
  processing: ["On its way", ""],
  hold: ["Needs you", "bad"],
  completed: ["Arrived", "ok"],
  failed: ["Didn't go through", "bad"],
};

const book = recipientBook();
const topups = topupBook();

/** Errand Save (save codes and Grow): its tab only shows when the API has it switched on too. */
const SAVE = import.meta.env.VITE_SAVE_ENABLED === "true";

/** The developer test page can make real payments, so it only exists in dev or when VITE_TEST_PAGE=true. */
const TEST_PAGE = import.meta.env.DEV || import.meta.env.VITE_TEST_PAGE === "true";

/** One line in Activity: a payment out or a top-up in. */
type Item = { kind: "order"; at: number; order: Order } | { kind: "topup"; at: number; topup: LocalTopup };

const shortDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });

function orderIcon(o: Order): IconName {
  const d = o.quote.intent.destination;
  if (d.kind === "fiat-payout") return d.recipient.type === "bank" ? "bank" : "phone";
  if (d.kind === "airtime") return "phone";
  return "bolt";
}

function ActivityRow({ item, onOpen }: { item: Item; onOpen: () => void }) {
  if (item.kind === "order") {
    const o = item.order;
    const [label, tone] = STATUS[o.state];
    return (
      <li>
        <button type="button" onClick={onOpen}>
          <span className="row-icon"><Icon name={orderIcon(o)} size={20} /></span>
          <span className="row-main">
            <strong>To {destinationLabel(o.quote.intent.destination)}</strong>
            <span>{shortDate(o.createdAt)}</span>
          </span>
          <span className="row-end">
            <span className="row-amount">−{formatMoney(o.quote.receive.amount, o.quote.receive.currency)}</span>
            <span className={`status ${tone}`}>{label}</span>
          </span>
        </button>
      </li>
    );
  }
  const t = item.topup;
  const [label, tone] = TOPUP_STATUS[t.state] ?? ["Checking", ""];
  return (
    <li>
      <button type="button" onClick={onOpen}>
        <span className="row-icon in"><Icon name="down" size={20} /></span>
        <span className="row-main">
          <strong>Added money</strong>
          <span>{shortDate(t.createdAt)} · {formatMoney(t.amount, t.currency)}</span>
        </span>
        <span className="row-end">
          <span className="row-amount">+{formatMoney(t.expectedNim, "NIM")}</span>
          <span className={`status ${tone}`}>{label}</span>
        </span>
      </button>
    </li>
  );
}

function App() {
  const [host, setHost] = useState<HostState | null>(null);
  const [corridors, setCorridors] = useState<Corridor[] | null>(null);
  const [view, setView] = useState<View>({ name: "tabs" });
  const [tab, setTab] = useState<Tab>("home");
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
    if (view.name === "tabs") void orderStore.list().then(setOrders);
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
    if (live && view.name === "tabs" && Date.now() - live.updatedAt < 6 * 3600_000) setView({ name: "order", id: live.id });
    // Only on first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders.length > 0]);

  if (host?.status === "outside-nimiq-pay") {
    return (
      <div className="screen">
        <div className="hero">
          <Hexagon size={40} />
          <h2>Errand runs inside Nimiq Pay</h2>
          <p className="hint">Open Nimiq Pay, go to Mini Apps, and open Errand from there.</p>
        </div>
      </div>
    );
  }

  if (signedIn === null) return <div className="screen"><p className="hint">Opening Errand…</p></div>;
  if (!signedIn) return <InviteGate onIn={() => setSignedIn(true)} />;

  const enabled = new Set((corridors ?? []).map((c) => c.id));
  const home = () => setView({ name: "tabs" });

  if (view.name === "send" && corridors) {
    return <SendHome enabled={corridors} start={view.start} autoQuote={view.autoQuote} onDone={(id) => setView({ name: "order", id })} onCancel={home} />;
  }
  if (view.name === "chat" && corridors) {
    return (
      <Chat
        first={view.text}
        enabled={corridors}
        onReady={(start) => setView({ name: "send", start, autoQuote: true })}
        onTopup={(prefill) => setView({ name: "topup", prefill })}
        onCancel={home}
        onManual={() => setView({ name: "send" })}
      />
    );
  }
  if (view.name === "topup") {
    return <AddMoney accounts={host?.status === "ready" ? host.accounts : []} prefill={view.prefill} openOrderId={view.orderId} onHome={home} />;
  }
  if (view.name === "scan") return <Scan enabled={enabled} onDone={(id) => setView({ name: "order", id })} onCancel={home} />;
  if (view.name === "order") {
    return (
      <OrderView
        orderId={view.id}
        enabled={enabled}
        onHome={home}
        onRetry={(o) => {
          const d = o.quote.intent.destination;
          if (d.kind !== "fiat-payout") return home();
          setView({ name: "send", start: { corridor: d.corridor, recipient: d.recipient, lastAmount: o.quote.receive.amount, usedAt: Date.now() } });
        }}
      />
    );
  }

  const saved = book.list().filter((s) => enabled.has(s.corridor));
  const items: Item[] = [
    ...orders.map((order) => ({ kind: "order" as const, at: order.createdAt, order })),
    ...topups.list().map((topup) => ({ kind: "topup" as const, at: topup.createdAt, topup })),
  ].sort((a, b) => b.at - a.at);
  const open = (i: Item) => (i.kind === "order" ? setView({ name: "order", id: i.order.id }) : setView({ name: "topup", orderId: i.topup.orderId }));
  const canSend = !!corridors && corridors.length > 0;

  return (
    <div className="screen with-tabs">
      {tab === "home" && (
        <>
          <header className="home-head">
            <h1>Errand</h1>
            <button type="button" className="icon-button" aria-label="Help" onClick={() => setTab("help")}><Icon name="help" /></button>
          </header>

          <section className="balance-card" aria-label="Your Nimiq Pay balance">
            <span className="label"><Hexagon size={18} /> Nimiq Pay balance</span>
            {host?.status === "ready" && host.balanceNim !== null ? (
              <p className="balance-amount">{formatMoney(host.balanceNim, "NIM").replace(/ NIM$/, "")}<small>NIM</small></p>
            ) : (
              <p className="balance-amount" style={{ fontSize: 20 }}>{host?.status === "error" ? "Not available" : "Connecting…"}</p>
            )}
            <p className="sub">
              {host?.status === "ready" && host.accounts.length > 1 ? `Across ${host.accounts.length} accounts` : "Errand never holds your money"}
            </p>
          </section>

          <nav className="actions" aria-label="Quick actions" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
            <button type="button" className="action" disabled={!canSend} onClick={() => setView({ name: "send" })}>
              <span className="disc"><Icon name="send" /></span>Send
            </button>
            <button type="button" className="action" onClick={() => setView({ name: "scan" })}>
              <span className="disc"><Icon name="scan" /></span>Pay a code
            </button>
            <button type="button" className="action" onClick={() => setView({ name: "topup" })}>
              <span className="disc"><Icon name="plus" /></span>Add money
            </button>
          </nav>

          <section className="ask-card" aria-label="Ask Errand">
            <ChatInput
              label="Ask Errand"
              placeholder="Ask Errand to send or add money…"
              value={sentence}
              onChange={setSentence}
              disabled={!corridors}
              onSend={() => {
                setView({ name: "chat", text: sentence.trim() });
                setSentence("");
              }}
            />
            <div className="suggestions">
              {(corridors?.some((c) => c.id === "ng-bank") ? ["Send ₦5,000 to 0123456789 GTBank", "Buy 100 NIM", "Add ₦10,000 to my wallet"] : ["Send 2,500 KES to Mary on M-Pesa", "Buy 100 NIM"]).map((t) => (
                <button key={t} type="button" className="suggestion" onClick={() => setSentence(t)}>{t}</button>
              ))}
            </div>
          </section>

          {host?.status === "error" && <p className="alert" role="alert">{host.message}</p>}
          {loadError && <p className="alert" role="alert">{loadError}</p>}

          {saved.length > 0 && (
            <section className="section">
              <h2 className="section-title">Send again</h2>
              <div className="people">
                {saved.map((s) => {
                  const r = s.recipient;
                  const name = r.type === "mobile-money" ? r.name : r.accountName;
                  return (
                    <button key={`${s.corridor}:${name}`} type="button" className="person" onClick={() => setView({ name: "send", start: s })}
                      aria-label={`Send to ${name} on ${CORRIDORS[s.corridor].label.split(": ")[1]}`}>
                      <Avatar name={name} />
                      <span>{name.split(" ")[0]}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          <section className="section">
            <div className="section-head">
              <h2 className="section-title">Recent activity</h2>
              {items.length > 5 && <button type="button" className="text-button" onClick={() => setTab("activity")}>See all</button>}
            </div>
            {items.length === 0 ? (
              <p className="empty">Your payments and top-ups show up here. Try "Send ₦5,000 to …" above.</p>
            ) : (
              <ul className="list">{items.slice(0, 5).map((i) => <ActivityRow key={i.kind + (i.kind === "order" ? i.order.id : i.topup.orderId)} item={i} onOpen={() => open(i)} />)}</ul>
            )}
          </section>
        </>
      )}

      {tab === "savings" && SAVE && <SaveHome address={host?.status === "ready" ? host.address : null} />}

      {tab === "activity" && (
        <>
          <header className="home-head"><h1>Activity</h1></header>
          {items.length === 0 ? (
            <p className="empty">Nothing yet. Payments you send and money you add show up here.</p>
          ) : (
            <ul className="list">{items.map((i) => <ActivityRow key={i.kind + (i.kind === "order" ? i.order.id : i.topup.orderId)} item={i} onOpen={() => open(i)} />)}</ul>
          )}
        </>
      )}

      {tab === "help" && (
        <>
          <header className="home-head"><h1>Help</h1></header>
          <div className="group">
            <div className="help-row">
              <strong>Errand never holds your money</strong>
              <p>Every payment is approved by you in Nimiq Pay's own window. Money you add goes straight from the provider to your Nimiq Pay address.</p>
            </div>
            <div className="help-row">
              <strong>Sending money home</strong>
              <p>Type it the way you'd say it, like "Send ₦5,000 to 0123456789 GTBank". Errand asks for anything missing and shows the price before you approve.</p>
            </div>
            <div className="help-row">
              <strong>Paying a code</strong>
              <p>Errand pays Lightning invoices, Lightning addresses and LNURL codes. Scan or paste one under Pay a code.</p>
            </div>
          </div>
          <section className="section">
            <h2 className="section-title">Something went wrong?</h2>
            <ReportProblem />
          </section>
          {TEST_PAGE && <a className="hint" href="#spike">Test page (developers only)</a>}
        </>
      )}

      <TabBar tab={tab} onTab={setTab} savings={SAVE} />
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
