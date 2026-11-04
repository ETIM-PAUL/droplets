import type { Bank, Draft, Missing, SaveIntent, TopupIntent } from "@railkit/agent";
import { CORRIDORS, validateRecipient, type Corridor, type PayoutRecipient } from "@railkit/core";
import { useEffect, useRef, useState } from "react";
import type { SavedRecipient } from "../storage";
import { AppBar, ChatInput } from "../ui";
import { api } from "./engine";

interface Props {
  first: string;
  enabled: Corridor[];
  /** Everything is known: go to the confirm card with a live price. */
  onReady: (start: SavedRecipient) => void;
  /** "buy 100 NIM": money coming in, so Add money takes over with the amount filled in. */
  onTopup: (prefill: TopupIntent) => void;
  /** "put 500 NIM in Grow": the user's own savings, so Savings takes over on the screen for it. Absent while savings is off. */
  onSave?: (intent: SaveIntent, notes: string[]) => void;
  /** The user's Nimiq address, for questions about their savings. */
  address?: string | null;
  onCancel: () => void;
  /** Fill it in step by step instead. */
  onManual: () => void;
}

interface Line {
  from: "you" | "errand";
  text: string;
  note?: boolean;
}

/**
 * The sentence flow: Errand reads what was typed, asks for what's missing one question at a time,
 * checks a Nigerian account holder's name with the bank, then hands over to the confirm card.
 * Nothing here can send money; only the confirm card's Send button and Nimiq Pay's own dialog can.
 */
export function Chat({ first, enabled, onReady, onTopup, onSave, address, onCancel, onManual }: Props) {
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState<Draft>({});
  const [expecting, setExpecting] = useState<Missing | null>(null);
  const [bankChoices, setBankChoices] = useState<Bank[]>([]);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState("");
  // After answering a savings question: a way into Savings, and the chat stays open for the next question.
  const [savingsLink, setSavingsLink] = useState(false);
  const started = useRef(false);
  const end = useRef<HTMLDivElement>(null);

  const say = (...l: Line[]) => setLines((x) => [...x, ...l]);

  // Braces matter: newer browsers return a Promise from scrollIntoView, and React would call it as a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [lines, busy]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void turn(first, {}, null);
    // Only the first sentence, once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function turn(text: string, before: Draft, exp: Missing | null) {
    say({ from: "you", text });
    setBusy(true);
    setBankChoices([]);
    setSavingsLink(false);
    try {
      const r = await api.understand(text, before, exp ?? undefined);
      if (r.intent === "topup") {
        onTopup(r.topup ?? {});
        return;
      }
      if (r.intent === "save") {
        if (!onSave) {
          say({ from: "errand", text: "Savings isn't switched on in Errand yet." });
          setBusy(false);
          return;
        }
        if (r.save?.action !== "ask") return onSave(r.save ?? { action: "show" }, r.notes);
        // A question: answered here, from the user's own savings. Nothing opens and nothing moves.
        if (!address) {
          say({ from: "errand", text: "Open Errand inside Nimiq Pay to ask about your savings." });
        } else {
          const a = await api.saveAsk({ address, question: text, kind: r.save.question, period: r.save.period, tzOffsetMinutes: -new Date().getTimezoneOffset() });
          say({ from: "errand", text: a.answer });
          setSavingsLink(true);
        }
        setExpecting(null);
        setBusy(false);
        return;
      }
      setDraft(r.draft);
      say(...r.notes.map((n) => ({ from: "errand" as const, text: n, note: true })));
      if (r.question) {
        say({ from: "errand", text: r.question });
        setExpecting(r.missing[0] ?? null);
        setBankChoices(r.bankChoices ?? []);
        setBusy(false);
        return;
      }
      setExpecting(null);
      await finish(r.draft);
    } catch (e) {
      say({ from: "errand", text: (e as Error).message, note: true });
      setBusy(false);
    }
  }

  async function finish(d: Draft) {
    const c = CORRIDORS[d.corridor!];
    let recipient: PayoutRecipient;
    if (c.recipientType === "mobile-money") {
      recipient = { type: "mobile-money", phone: d.phone!, name: d.name!, network: c.network! };
    } else {
      let accountName = d.name ?? "";
      if (c.country === "NG") {
        say({ from: "errand", text: `Checking the account with ${d.bank!.name}…` });
        try {
          accountName = (await api.nameEnquiry(d.accountNumber!, d.bank!.code)).accountName;
        } catch (e) {
          say({ from: "errand", text: (e as Error).message, note: true }, { from: "errand", text: "What's the 10-digit account number?" });
          setDraft({ ...d, accountNumber: undefined });
          setExpecting("account");
          setBusy(false);
          return;
        }
        say({ from: "errand", text: `The account belongs to ${accountName}.` });
      }
      recipient = { type: "bank", bankCode: d.bank!.code, bankName: d.bank!.name, accountNumber: d.accountNumber!, accountName };
    }
    const v = validateRecipient(c.id, recipient);
    if (!v.ok) {
      say({ from: "errand", text: v.error.message, note: true });
      setBusy(false);
      return;
    }
    onReady({ corridor: c.id, recipient: v.value, lastAmount: d.amount!, usedAt: Date.now() });
  }

  const answer = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    setReply("");
    void turn(t, draft, expecting);
  };

  return (
    <div className="screen">
      <AppBar title="Ask Errand" onBack={onCancel} backLabel="Cancel" right={<button type="button" className="text-button" onClick={onManual}>Step by step</button>} />

      <div className="grow">
        <div className="chat" aria-live="polite">
          {lines.map((l, i) => (
            <p key={i} className={`bubble ${l.from}${l.note ? " note-bubble" : ""}`}>{l.text}</p>
          ))}
          {busy && <p className="bubble errand typing" aria-label="Errand is thinking">…</p>}
          <div ref={end} />
        </div>

        {!busy && expecting === "corridor" && (
          <div className="choices">
            {enabled.map((c) => (
              <button key={c.id} type="button" className="choice" onClick={() => answer(c.label)}>
                {c.label.split(": ")[1]}
                <small>{c.label.split(": ")[0]}, {c.currency}</small>
              </button>
            ))}
          </div>
        )}
        {!busy && savingsLink && onSave && (
          <div className="choices">
            <button type="button" className="choice" onClick={() => onSave({ action: "show" }, [])}>
              Open Savings
              <small>Your Grow balance, save code and payments in</small>
            </button>
          </div>
        )}
        {!busy && bankChoices.length > 0 && (
          <div className="choices">
            {bankChoices.map((b) => (
              <button key={b.code} type="button" className="choice" onClick={() => answer(b.name)}>{b.name}</button>
            ))}
          </div>
        )}

        <div className="grow" />
        <div className="dock">
          <ChatInput
            label="Your answer"
            placeholder={expecting ? "Type your answer…" : "Message Errand…"}
            value={reply}
            onChange={setReply}
            onSend={() => answer(reply)}
            busy={busy}
            inputMode={expecting === "phone" || expecting === "account" ? "tel" : expecting === "amount" ? "decimal" : "text"}
            autoFocus
            size="compact"
          />
        </div>
      </div>
    </div>
  );
}
