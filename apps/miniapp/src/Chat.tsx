import type { SaveIntent } from "@railkit/agent";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { ConfirmCard } from "./save/Confirm";
import { canConfirm } from "./save/confirm-plan";
import { AppBar, ChatInput } from "./ui";

/** Things to try. Each is one the chat's rules already read as a savings request or question. */
export const SUGGESTIONS = ["How much have I saved?", "Save 30% of what apps pay me", "Put 500 NIM in savings", "When can I get my money?"];

const NOT_SAVINGS = "Errand is for saving, so it can't send money or buy NIM. Ask about your savings, or tell me how much to save.";

interface Props {
  /** What was typed or tapped on Savings. */
  first: string;
  /** The user's Nimiq address, for questions about their savings. */
  address: string | null;
  /** "put 500 NIM in Grow": Savings takes over on the screen for it, filled in. */
  onSave: (intent: SaveIntent, notes: string[]) => void;
  onCancel: () => void;
}

interface Line {
  from: "you" | "errand";
  text: string;
}

/**
 * Ask Errand: a savings request opens the right screen, filled in, and a question is answered from the
 * user's own savings. Nothing here can move money; only Nimiq Pay's own dialog can.
 */
export function Chat({ first, address, onSave, onCancel }: Props) {
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState("");
  // After an answer: a way into Savings. After something Errand doesn't do: things to try instead.
  const [after, setAfter] = useState<"savings" | "suggestions" | null>(null);
  const started = useRef(false);
  /** A change ready to confirm: shown as a card with the exact values, which is the only thing that can reach Nimiq Pay. */
  const [pending, setPending] = useState<{ intent: SaveIntent; notes: string[]; id: number } | null>(null);
  const end = useRef<HTMLDivElement>(null);

  const say = (...l: Line[]) => setLines((x) => [...x, ...l]);

  // Braces matter: newer browsers return a Promise from scrollIntoView, and React would call it as a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [lines, busy]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (first.trim()) void turn(first);
    else {
      // Opened from a button: a greeting and things to try, nothing sent yet.
      say({ from: "errand", text: "Ask about your savings, or tell me what to change. Nothing moves without your approval in Nimiq Pay." });
      setAfter("suggestions");
    }
    // Only the first message, once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function turn(text: string) {
    say({ from: "you", text });
    setBusy(true);
    setAfter(null);
    setPending(null);
    try {
      const r = await api.understand(text);
      if (r.intent !== "save") {
        say({ from: "errand", text: NOT_SAVINGS });
        setAfter("suggestions");
      } else if (r.save?.action !== "ask") {
        const s = r.save ?? { action: "show" };
        // Only a complete request with nothing in doubt gets a Confirm button; anything else opens its form, filled in.
        if (!address || !canConfirm(s) || r.notes.length > 0) return onSave(s, r.notes);
        // The card says what it is: the change to confirm, or why it needs the form.
        setPending({ intent: s, notes: r.notes, id: Date.now() });
      } else if (!address) {
        say({ from: "errand", text: "Open Errand inside Nimiq Pay to ask about your savings." });
      } else {
        // A question: answered here, from the user's own savings. Nothing opens and nothing moves.
        const a = await api.saveAsk({ address, question: text, kind: r.save.question, period: r.save.period, tzOffsetMinutes: -new Date().getTimezoneOffset() });
        say({ from: "errand", text: a.answer });
        setAfter("savings");
      }
    } catch (e) {
      say({ from: "errand", text: (e as Error).message });
    }
    setBusy(false);
  }

  const send = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    setReply("");
    void turn(t);
  };

  return (
    <div className="screen">
      <AppBar title="Ask Errand" onBack={onCancel} backLabel="Close" />

      <div className="grow">
        <div className="chat" aria-live="polite">
          {lines.map((l, i) => (
            <p key={i} className={`bubble ${l.from}`}>{l.text}</p>
          ))}
          {busy && <p className="bubble errand typing" aria-label="Errand is thinking">…</p>}
          <div ref={end} />
        </div>

        {!busy && pending && (
          <ConfirmCard
            key={pending.id}
            intent={pending.intent}
            address={address}
            onDone={(text) => {
              setPending(null);
              say({ from: "errand", text });
              setAfter("savings");
            }}
            onForm={() => onSave(pending.intent, pending.notes)}
            onCancel={() => {
              setPending(null);
              say({ from: "errand", text: "Cancelled. Nothing changed." });
            }}
          />
        )}
        {!busy && after === "savings" && (
          <div className="choices">
            <button type="button" className="choice" onClick={() => onSave({ action: "show" }, [])}>
              Open your savings
              <small>Your balance, save code and payments in</small>
            </button>
          </div>
        )}
        {!busy && after === "suggestions" && (
          <div className="suggestions">
            {SUGGESTIONS.map((t) => (
              <button key={t} type="button" className="suggestion" onClick={() => send(t)}>{t}</button>
            ))}
          </div>
        )}

        <div className="grow" />
        <div className="dock">
          <ChatInput label="Your message" placeholder="Message Errand…" value={reply} onChange={setReply} onSend={() => send(reply)} busy={busy} autoFocus size="compact" />
        </div>
      </div>
    </div>
  );
}
