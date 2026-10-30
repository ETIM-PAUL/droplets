import { useState } from "react";
import { api } from "./send/engine";

/** Sends a note straight to the team, tagged with the order when there is one. */
export function ReportProblem({ orderId }: { orderId?: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | string>("idle");

  if (state === "sent") return <p className="hint" role="status">Thanks. The team has your report{orderId ? " and this payment's details" : ""}.</p>;
  if (!open) return <button type="button" className="secondary" onClick={() => setOpen(true)}>Report a problem</button>;

  async function send() {
    setState("sending");
    try {
      await api.feedback(text, orderId);
      setState("sent");
    } catch (e) {
      setState(e instanceof Error ? e.message : "Couldn't send. Try again.");
    }
  }

  return (
    <form className="field" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <label htmlFor="report">What went wrong?</label>
      <textarea id="report" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
      {state !== "idle" && state !== "sending" && <p className="alert" role="alert">{state}</p>}
      <button className="secondary" disabled={!text.trim() || state === "sending"}>{state === "sending" ? "Sending…" : "Send report"}</button>
    </form>
  );
}
