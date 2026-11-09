import "@fontsource-variable/mulish";
import type { SaveIntent } from "@railkit/agent";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, SIGNED_OUT } from "./api";
import { Chat } from "./Chat";
import { demoTab } from "./demo";
import { Help } from "./Help";
import { connectHost, type HostState } from "./host";
import { InviteGate } from "./InviteGate";
import { ActivityTab } from "./save/Activity";
import { DrawCard, DrawTab } from "./save/Draw";
import { SaveHome } from "./save/SaveHome";
import { sessionToken } from "./storage";
import { AppBar, Droplet, TabBar, type Tab } from "./ui";
import "./styles.css";

/** The tabs, or one screen over them: Ask Droplets, or Help. */
type View = { name: "tabs" } | { name: "chat"; text: string } | { name: "help" };
const TABS: Tab[] = ["home", "activity", "draw", "profile"];
const firstTab = (): Tab => {
  const t = import.meta.env.DEV ? demoTab() : null;
  return TABS.includes(t as Tab) ? (t as Tab) : "home";
};

function App() {
  const [host, setHost] = useState<HostState | null>(null);
  const [view, setView] = useState<View>({ name: "tabs" });
  const [tab, setTab] = useState<Tab>(firstTab);
  /** An inner savings screen is open: it has its own back button, so the tab bar steps aside. */
  const [inner, setInner] = useState(false);
  const openTab = (t: Tab) => {
    setTab(t);
    setInner(false);
    window.scrollTo({ top: 0 });
  };
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
          <Droplet size={44} />
          <h2>Droplets runs inside Nimiq Pay</h2>
          <p className="hint">Open Nimiq Pay, go to Mini Apps, and open Droplets from there.</p>
        </div>
      </div>
    );
  }

  if (signedIn === null) return <div className="screen"><p className="hint loading-line">Opening Droplets…</p></div>;
  if (!signedIn) return <InviteGate onIn={() => setSignedIn(true)} />;

  const address = host?.status === "ready" ? host.address : null;
  const home = () => setView({ name: "tabs" });
  const ask = () => setView({ name: "chat", text: "" });

  if (view.name === "chat") {
    return (
      <Chat
        first={view.text}
        address={address}
        onSave={(intent, notes) => {
          setSaveStart({ intent, notes });
          openTab("home");
          home();
        }}
        onCancel={home}
      />
    );
  }

  if (view.name === "help") {
    return (
      <div className="screen">
        <AppBar title="How Droplets works" onBack={home} />
        <Help />
      </div>
    );
  }

  // Home and Profile are two views of the same savings: one keeps them in step.
  const savings = tab === "home" || tab === "profile";
  return (
    <div className={`screen${inner ? "" : " with-tabs"}`}>
      {host?.status === "error" && <p className="alert" role="alert">{host.message}</p>}
      {savings && (
        <SaveHome
          address={address}
          tab={tab}
          start={saveStart}
          onStarted={() => setSaveStart(null)}
          draw={<DrawCard address={address} compact onOpen={() => openTab("draw")} />}
          onTab={openTab}
          onAsk={ask}
          onHelp={() => setView({ name: "help" })}
          onInner={setInner}
        />
      )}
      {tab === "activity" && <ActivityTab address={address} />}
      {tab === "draw" && <DrawTab address={address} />}
      {!inner && <TabBar tab={tab} onTab={openTab} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
