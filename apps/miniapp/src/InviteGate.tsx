import { useState } from "react";
import { api } from "./send/engine";
import { sessionToken } from "./storage";
import { Hexagon } from "./ui";

/** The closed beta's front door: one code per tester. */
export function InviteGate({ onIn }: { onIn: (name: string | null) => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function enter() {
    setBusy(true);
    setError(null);
    try {
      const s = await api.session(code);
      // With the beta off the server issues no token; remember that so this screen stays away.
      sessionToken.set(s.token ?? "open");
      onIn(s.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="screen" onSubmit={(e) => { e.preventDefault(); void enter(); }}>
      <div className="hero">
        <Hexagon size={40} />
        <h2>Welcome to Errand</h2>
        <p className="hint">Errand is invite-only while we test it with friends and family.</p>
      </div>
      <div className="grow">
        <div className="field">
          <label htmlFor="invite">Your invite code</label>
          <input id="invite" autoCapitalize="characters" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
        <p className="hint">Ask the person who invited you if you don't have one.</p>
        {error && <p className="alert" role="alert">{error}</p>}
        <div className="grow" />
        <button className="primary bottom" disabled={!code.trim() || busy}>{busy ? "Checking…" : "Join the beta"}</button>
      </div>
    </form>
  );
}
