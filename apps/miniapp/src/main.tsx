import type { SaveIntent } from "@railkit/agent";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, SIGNED_OUT } from "./api";
import { Chat, SUGGESTIONS } from "./Chat";
import { Help } from "./Help";
import { connectHost, type HostState } from "./host";
import { InviteGate } from "./InviteGate";
import { ActivityTab } from "./save/Activity";
import { SavingsTab } from "./save/SavingsTab";
import { sessionToken } from "./storage";
import { ChatInput, Hexagon, TabBar, type Tab } from "./ui";
import "./styles.css";

/** Steady and Boost (the two-sided pool), inside Savings. Needs POOL_ENABLED on the API and the pool worker. */
const POOL = import.meta.env.VITE_POOL_ENABLED === "true";

type View = { name: "tabs" } | { name: "chat"; text: string };

/** Ask Errand, on Savings: a request opens the right screen filled in, and a question gets an answer. */
function AskCard({ onAsk }: { onAsk: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <section className="section" aria-label="Ask Errand">
      <h2 className="section-title">Ask Errand</h2>
      <div className="ask-card">
        <ChatInput label="Ask Errand" placeholder="Ask about your savings…" value={text} onChange={setText} onSend={() => onAsk(text.trim())} size="compact" />
        <div className="suggestions">
          {SUGGESTIONS.map((t) => (
            <button key={t} type="button" className="suggestion" onClick={() => onAsk(t)}>{t}</button>
          ))}
        </div>
      </div>
    </section>
  );
}

function App() {
  const [host, setHost] = useState<HostState | null>(null);
  const [view, setView] = useState<View>({ name: "tabs" });
  const [tab, setTab] = useState<Tab>("home");
  // A savings request from the chat ("put 500 NIM in Grow"): Savings opens the screen for it.
  const [saveStart, setSaveStart] = useState<{ intent: SaveIntent; notes: string[] } | null>(null);
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

  // Savings only needs the address, which Nimiq Pay shares before the balance.
  useEffect(() => {
    void connectHost().then(setHost);
  }, []);

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

  const address = host?.status === "ready" ? host.address : null;
  const home = () => setView({ name: "tabs" });

  if (view.name === "chat") {
    return (
      <Chat
        first={view.text}
        address={address}
        onSave={(intent, notes) => {
          setSaveStart({ intent, notes });
          setTab("home");
          home();
        }}
        onCancel={home}
      />
    );
  }

  return (
    <div className="screen with-tabs">
      {host?.status === "error" && <p className="alert" role="alert">{host.message}</p>}
      {tab === "home" && (
        <SavingsTab
          address={address}
          pool={POOL}
          start={saveStart}
          onStarted={() => setSaveStart(null)}
          ask={<AskCard onAsk={(text) => setView({ name: "chat", text })} />}
          onSeeAll={() => setTab("activity")}
        />
      )}
      {tab === "activity" && <ActivityTab address={address} pool={POOL} />}
      {tab === "help" && <Help pool={POOL} />}
      <TabBar tab={tab} onTab={setTab} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
