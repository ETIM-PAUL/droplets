import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { qrModules, qrPath } from "./qr-code";

/** The few icons Droplets uses, drawn inline on a 24px grid so they inherit text colour. */
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
  drop: "M12 3.5c3.6 4.3 6 7.7 6 10.6a6 6 0 0 1-12 0c0-2.9 2.4-6.3 6-10.6z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0",
  chat: "M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.4-4.6A7.5 7.5 0 1 1 20 11.5z",
  gift: "M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-7M3 8h18v4H3zM12 20V8M12 8H8a2 2 0 1 1 0-4c2.5 0 4 4 4 4zM12 8h4a2 2 0 1 0 0-4c-2.5 0-4 4-4 4z",
  copy: "M9 9h10v10H9zM15 9V5H5v10h4",
  qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2M14 18h2M18 18h2v2h-2z",
  apps: "M5 5h5v5H5zM14 5h5v5h-5zM5 14h5v5H5zM14 14h5v5h-5z",
  repeat: "M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4",
  tag: "M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9zM7.5 7.5h.01",
  flag: "M6 3v18M6 4h12l-3 3.5 3 3.5H6",
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

export type Tab = "home" | "goals" | "activity" | "draw" | "profile";

export function TabBar({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const items: { id: Tab; label: string; icon: IconName }[] = [
    { id: "home", label: "Home", icon: "home" },
    { id: "goals", label: "Goals", icon: "flag" },
    { id: "activity", label: "Activity", icon: "list" },
    { id: "draw", label: "Draw", icon: "gift" },
    { id: "profile", label: "Profile", icon: "user" },
  ];
  return (
    <nav className="tabbar" aria-label="Main">
      {items.map((i) => (
        <button key={i.id} type="button" className="tab" aria-current={tab === i.id ? "page" : undefined} onClick={() => onTab(i.id)}>
          <span className="tab-icon"><Icon name={i.icon} /></span>
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

/** A main tab's heading, with anything that belongs beside it on the right. */
export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="page-head">
      <h1>{title}</h1>
      {children}
    </header>
  );
}

/** A setting or link in a grouped list: what it is on the left, its current value and a chevron on the right. */
export function SettingRow({ icon, label, value, onClick, danger }: { icon?: IconName; label: string; value?: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" className={`setting${danger ? " danger" : ""}`} onClick={onClick}>
      {icon && <span className="setting-icon"><Icon name={icon} size={20} /></span>}
      <span className="setting-label">{label}</span>
      {value && <span className="setting-value">{value}</span>}
      <span className="setting-chevron"><Icon name="chevron" size={18} /></span>
    </button>
  );
}

/** The Droplets mark: a teal drop. */
export function Droplet({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.5c4 4.7 6.6 8.4 6.6 11.7a6.6 6.6 0 0 1-13.2 0c0-3.3 2.6-7 6.6-11.7z" fill="var(--teal)" />
      <path d="M9 14.5a3 3 0 0 0 3 3" fill="none" stroke="#fff" strokeOpacity="0.7" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

interface ChatInputProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  placeholder: string;
  label: string;
  /** While Droplets is answering: typing stays possible, sending waits. */
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
