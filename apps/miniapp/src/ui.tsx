import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { qrModules, qrPath } from "./qr-code";

/** The few icons Errand uses, drawn inline on a 24px grid so they inherit text colour. */
const PATHS = {
  back: "M15 5l-7 7 7 7",
  send: "M12 19V5M5 12l7-7 7 7",
  plus: "M12 5v14M5 12h14",
  scan: "M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10",
  bolt: "M13 3L5 13h6l-1 8 8-10h-6l1-8z",
  home: "M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1v-8z",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01",
  chevron: "M9 6l6 6-6 6",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6",
  bank: "M4 10h16M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18M12 3l9 5H3l9-5z",
  phone: "M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2",
  check: "M5 12l5 5 9-10",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  close: "M6 6l12 12M18 6L6 18",
  down: "M12 5v14M5 12l7 7 7-7",
  jar: "M8 3h8M9 3v3L7 8.5V19a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V8.5L15 6V3M7 12h10",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Top of every inner screen: a back button, the screen's name, and an optional action on the right. */
export function AppBar({ title, onBack, backLabel = "Back", right }: { title: string; onBack?: () => void; backLabel?: string; right?: ReactNode }) {
  return (
    <header className="appbar">
      {onBack ? (
        <button type="button" className="icon-button" onClick={onBack} aria-label={backLabel}>
          <Icon name="back" />
        </button>
      ) : <span className="appbar-spacer" />}
      <h1 className="appbar-title">{title}</h1>
      {right ?? <span className="appbar-spacer" />}
    </header>
  );
}

export type Tab = "home" | "savings" | "activity" | "help";

export function TabBar({ tab, onTab, savings = false }: { tab: Tab; onTab: (t: Tab) => void; savings?: boolean }) {
  const items: { id: Tab; label: string; icon: IconName }[] = [
    { id: "home", label: "Home", icon: "home" },
    ...(savings ? [{ id: "savings" as const, label: "Savings", icon: "jar" as const }] : []),
    { id: "activity", label: "Activity", icon: "list" },
    { id: "help", label: "Help", icon: "help" },
  ];
  return (
    <nav className="tabbar" aria-label="Main">
      {items.map((i) => (
        <button key={i.id} type="button" className="tab" aria-current={tab === i.id ? "page" : undefined} onClick={() => onTab(i.id)}>
          <Icon name={i.icon} />
          <span>{i.label}</span>
        </button>
      ))}
    </nav>
  );
}

/** A QR code, always black on white: scanners need that contrast whatever the app's theme. */
export function QrCode({ text, label, size = 200 }: { text: string; label: string; size?: number }) {
  const { n, d } = useMemo(() => {
    const { size: modules, dark } = qrModules(text);
    return { n: modules, d: qrPath(dark) };
  }, [text]);
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${n} ${n}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

/** Initials in a circle, for people in lists. */
export function Avatar({ name }: { name: string }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
  return <span className="avatar" aria-hidden="true">{initials}</span>;
}

/** Nimiq's hexagon, the one bit of brand on the balance card. */
export function Hexagon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M17.4 3.6H6.6L1.2 12l5.4 8.4h10.8l5.4-8.4-5.4-8.4z" fill="var(--gold)" />
    </svg>
  );
}

interface ChatInputProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  placeholder: string;
  label: string;
  /** While Errand is answering: typing stays possible, sending waits. */
  busy?: boolean;
  disabled?: boolean;
  inputMode?: "text" | "tel" | "decimal";
  autoFocus?: boolean;
  /** "compact" for replies inside the chat: one line that grows, button beside it. */
  size?: "large" | "compact";
}

/**
 * A chat message box: three lines tall, growing to about eight as you type. Enter sends,
 * Shift+Enter adds a line, and the send button sits in the box's bottom corner.
 */
export function ChatInput({ value, onChange, onSend, placeholder, label, busy, disabled, inputMode = "text", autoFocus, size = "large" }: ChatInputProps) {
  const compact = size === "compact";
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, compact ? 24 : 84), compact ? 120 : 200)}px`;
  }, [value, compact]);
  const canSend = !busy && !disabled && value.trim().length > 0;
  return (
    <form className={`chatbox${compact ? " compact" : ""}`} onSubmit={(e) => { e.preventDefault(); if (canSend) onSend(); }}>
      <textarea
        ref={ref}
        rows={compact ? 1 : 3}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        inputMode={inputMode}
        maxLength={300}
        autoComplete="off"
        autoFocus={autoFocus}
        enterKeyHint="send"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (canSend) onSend();
          }
        }}
      />
      <div className="chatbox-foot">
        {value.length > 240
          ? <span className="chatbox-hint">{300 - value.length} characters left</span>
          : <span className="chatbox-hint keys">Shift+Enter for a new line</span>}
        <button type="submit" className="chatbox-send" aria-label="Send message" disabled={!canSend}>
          <Icon name="send" size={18} />
        </button>
      </div>
    </form>
  );
}
