import type { SaveApp, SaveAppKey } from "@railkit/client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import { Droplet, Icon, type IconName } from "./ui";

/** The docs site (GitBook), once it exists: set VITE_DOCS_URL to its address and the page links to it. */
const DOCS_URL = typeof import.meta.env.VITE_DOCS_URL === "string" && import.meta.env.VITE_DOCS_URL.startsWith("https://") ? import.meta.env.VITE_DOCS_URL : null;

/** What a browser shows: Droplets only runs inside Nimiq Pay, so anyone else gets the page that explains it. */
export function Landing() {
  return (
    <div className="lp">
      <header className="lp-top">
        <a className="lp-brand" href="#top" aria-label="Droplets, back to top">
          <Droplet size={30} />
          <span>Droplets</span>
        </a>
        <nav className="lp-nav" aria-label="On this page">
          <a className="lp-nav-link" href="#for-apps">For apps</a>
          {DOCS_URL && <a className="lp-nav-link" href={DOCS_URL} target="_blank" rel="noopener noreferrer">Docs</a>}
          <a className="lp-top-link" href="#start">Start saving</a>
        </nav>
      </header>

      <main id="top">
        <section className="lp-hero" aria-labelledby="lp-title">
          <div className="lp-hero-text">
            <h1 id="lp-title">Every payment leaves a droplet.</h1>
            <p className="lp-lede">
              Droplets is a savings Mini App for Nimiq Pay. A small share of the NIM you're paid, and of the NIM you spend, goes into
              savings: NIM staked from your own account, kept apart from your spending money.
            </p>
            <div className="lp-actions">
              <a className="lp-button" href="#start">Start saving</a>
              <a className="lp-quiet" href="#how">How it works</a>
            </div>
          </div>
          <DripDemo />
        </section>

        <section id="how" className="lp-section" aria-labelledby="lp-how">
          <h2 id="lp-how">How your savings fill up</h2>
          <p className="lp-intro">You set the shares once, in your profile. You can change them or turn them off any time.</p>
          <ul className="lp-ways">
            {WAYS.map((w) => (
              <li key={w.title}>
                <span className="lp-way-icon"><Icon name={w.icon} size={22} /></span>
                <h3>{w.title}</h3>
                <p>{w.text}</p>
              </li>
            ))}
          </ul>
        </section>

        <section id="apps" className="lp-section" aria-labelledby="lp-apps">
          <h2 id="lp-apps">Apps that work with Droplets</h2>
          <p className="lp-intro">These apps can save for you. Give them your save code, or pick them in your saving rules.</p>
          <AppsList />
        </section>

        <section className="lp-band" aria-labelledby="lp-yours">
          <div className="lp-band-inner">
            <h2 id="lp-yours">Your savings never leave your account</h2>
            <ul className="lp-facts">
              <li>
                <strong>Staked from your own account</strong>
                <p>With a validator Droplets suggests or one you choose. They earn staking rewards, and nobody holds them but you.</p>
              </li>
              <li>
                <strong>You approve every change</strong>
                <p>Each saving rule, deposit and withdrawal opens Nimiq Pay's own approval window. Nothing moves without it.</p>
              </li>
              <li>
                <strong>Out in 12 to 24 hours</strong>
                <p>Nimiq releases staked NIM at the end of an epoch. Then you finish the withdrawal on Home.</p>
              </li>
            </ul>
          </div>
        </section>

        <section className="lp-section lp-draw" aria-labelledby="lp-draw">
          <span className="lp-draw-mark" aria-hidden="true"><Icon name="gift" size={28} /></span>
          <div>
            <h2 id="lp-draw">A weekly draw for keeping your savings</h2>
            <p>
              Keep the minimum saved on enough days of the week and you're in that Sunday's draw. Keeping more gives you more tickets.
              The winner is picked with a Nimiq block made after the draw time, so nobody can know it in advance, and you never risk any
              of your savings.
            </p>
          </div>
        </section>

        <section className="lp-section" aria-labelledby="lp-inside">
          <h2 id="lp-inside">Inside the app</h2>
          <ul className="lp-shots">
            {SHOTS.map((s) => (
              <li key={s.file}>
                <img src={`/screens/${s.file}.jpg`} width={480} height={1038} loading="lazy" decoding="async" alt={s.alt} />
                <span>{s.label}</span>
              </li>
            ))}
          </ul>
        </section>

        <section id="for-apps" className="lp-section lp-builders" aria-labelledby="lp-builders">
          <h2 id="lp-builders">For apps that pay NIM</h2>
          <p>
            Games, bounties and shops can save for their users with Droplets. Before each payout, your app asks Droplets how to split it,
            then sends the saved part into the user's stake and the rest to their wallet. If Droplets doesn't answer within 3 seconds, it
            pays normally. Users who haven't picked your app get a plain payment, so no app can tell who uses Droplets.
          </p>
          <p>Register your app to get its key. We review each new app, and the key starts working once yours is approved.{DOCS_URL && <> The <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">docs</a> walk through the integration.</>}</p>
          <RegisterApp />
        </section>

        <section id="start" className="lp-section lp-start" aria-labelledby="lp-start">
          <h2 id="lp-start">Start saving</h2>
          <ol className="lp-steps">
            <li>
              <h3>Get Nimiq Pay</h3>
              <p>Droplets runs inside the Nimiq Pay wallet app, on your phone.</p>
            </li>
            <li>
              <h3>Open Droplets</h3>
              <p>In Nimiq Pay, go to Mini Apps and open this address:</p>
              <CopyField text={window.location.origin} shown={window.location.host} />
            </li>
            <li>
              <h3>Open your savings and choose your share</h3>
              <p>Put in at least 100 NIM, Nimiq's minimum for staking. Then pick how much of what apps pay you goes to savings, and sign it. Signing is free.</p>
            </li>
          </ol>
        </section>
      </main>

      <footer className="lp-foot">
        <span className="lp-brand small"><Droplet size={22} /><span>Droplets</span></span>
        <p>A savings Mini App for Nimiq Pay. Your savings are NIM staked from your own account.</p>
      </footer>
    </div>
  );
}

const WAYS: { icon: IconName; title: string; text: string }[] = [
  {
    icon: "tag",
    title: "A save code for apps that pay you",
    text: "Give your code to apps that work with Droplets, like games, bounties and shops. Each time one pays you, your share goes into savings and the rest to your wallet.",
  },
  {
    icon: "apps",
    title: "Apps that already know your address",
    text: "Most apps get your address from Nimiq Pay. If one you use works with Droplets, pick it and it saves for you. Apps you didn't pick can't tell you use Droplets.",
  },
  {
    icon: "drop",
    title: "A little extra when you pay",
    text: "Choose a share, like 5%. Apps you picked add it on top when you buy something and put it into savings. You see the full amount before you approve.",
  },
  {
    icon: "repeat",
    title: "A catch-up for everything else",
    text: "Droplets adds up your share of other spending each day, week, two weeks or month, and shows it with a Save button. Nothing leaves your wallet until you approve.",
  },
];

const SHOTS = [
  { file: "home", label: "Home", alt: "Home: savings balance, this week's catch-up and the weekly draw" },
  { file: "activity", label: "Activity", alt: "Activity: saved payouts and deposits, grouped by day" },
  { file: "draw", label: "Draw", alt: "Draw: this week's kept days and tickets" },
  { file: "profile", label: "Profile", alt: "Profile: save code and saving rules" },
];

/** The example in the hero: three payments, each leaving a droplet in savings. Played once; still under reduced motion. */
const DRIPS = [
  { what: "Game payout", why: "30% of a payout", amount: "+200 NIM", saved: 60 },
  { what: "Coffee", why: "5% on top when you pay", amount: "−8 NIM", saved: 0.4 },
  { what: "Bounty", why: "30% of a payout", amount: "+50 NIM", saved: 15 },
];
const START_SAVINGS = 1209.1;
/** Water level in the savings pool after each droplet lands, as a share of its height. */
const LEVELS = [0.18, 0.33, 0.34, 0.43];
const nimFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function DripDemo() {
  const still = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  // shown: rows whose droplet has appeared; landed: droplets already in the pool.
  const [shown, setShown] = useState(still ? DRIPS.length : 0);
  const [landed, setLanded] = useState(still ? DRIPS.length : 0);

  const figure = useRef<HTMLElement>(null);

  // Plays once it's in view: on a phone the example sits below the fold.
  useEffect(() => {
    if (still) return;
    let timers: ReturnType<typeof setTimeout>[] = [];
    const play = () => {
      timers = DRIPS.flatMap((_, i) => [
        setTimeout(() => setShown(i + 1), 400 + i * 900),
        setTimeout(() => setLanded(i + 1), 950 + i * 900),
      ]);
    };
    const el = figure.current;
    let io: IntersectionObserver | null = null;
    if (el && "IntersectionObserver" in window) {
      io = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          io?.disconnect();
          play();
        },
        { threshold: 0.6 },
      );
      io.observe(el);
    } else play();
    return () => {
      io?.disconnect();
      timers.forEach(clearTimeout);
    };
  }, [still]);

  const total = DRIPS.slice(0, landed).reduce((sum, d) => sum + d.saved, START_SAVINGS);
  const falling = shown > landed;

  return (
    <figure ref={figure} className="drip" aria-label="An example: three payments each leave a droplet in savings, which grow from 1,209.10 to 1,284.50 NIM.">
      <ul className="drip-rows" aria-hidden="true">
        {DRIPS.map((d, i) => (
          <li key={d.what} className={i < shown ? "on" : ""}>
            <span className="drip-what">
              <strong>{d.what}</strong>
              <small>{d.why}</small>
            </span>
            <span className="drip-side">
              <span className="drip-amount">{d.amount}</span>
              <span className="drip-saved">
                <svg width="10" height="12" viewBox="0 0 24 28" aria-hidden="true"><path d="M12 2c5 6 9 11 9 15.5a9 9 0 0 1-18 0C3 13 7 8 12 2z" fill="currentColor" /></svg>
                {nimFmt.format(d.saved)}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <div className="drip-channel" aria-hidden="true">
        {falling && <span key={shown} className="drip-fall" />}
      </div>
      <div className="drip-pool" aria-hidden="true">
        <span className="drip-water" style={{ height: `${(LEVELS[landed] ?? 0) * 100}%` }}>
          <svg className="drip-wave" viewBox="0 0 120 8" preserveAspectRatio="none"><path d="M0 4c10 0 10-4 20-4s10 4 20 4 10-4 20-4 10 4 20 4 10-4 20-4 10 4 20 4v4H0z" /></svg>
        </span>
        <span className="drip-label">Savings</span>
        <strong className="drip-total">{nimFmt.format(total)} NIM</strong>
      </div>
    </figure>
  );
}

/** Text to copy, like this page's address or an app key, with a Copy button. */
function CopyField({ text, shown = text, code = false }: { text: string; shown?: string; code?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => setCopied(false),
    );
  };
  return (
    <div className="lp-address">
      {code ? <code>{shown}</code> : <span>{shown}</span>}
      <button type="button" onClick={copy} aria-live="polite">
        <Icon name={copied ? "check" : "copy"} size={18} />
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

type AppsState = { status: "loading" } | { status: "error" } | { status: "ready"; apps: SaveApp[] };

/** The approved apps, from the API. Only https links are shown as links. */
function AppsList() {
  const [state, setState] = useState<AppsState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    // The server sleeps when idle and can take a minute to wake, so it gets a second try before the page gives up.
    const get = () => api.saveApps();
    get()
      .catch(() => new Promise((r) => setTimeout(r, 4000)).then(get))
      .then(
        (apps) => live && setState({ status: "ready", apps }),
        () => live && setState({ status: "error" }),
      );
    return () => {
      live = false;
    };
  }, [attempt]);

  if (state.status === "loading") return <p className="lp-muted" aria-live="polite">Loading the list of apps…</p>;
  if (state.status === "error") {
    return (
      <p className="lp-muted">
        The list of apps didn't load.{" "}
        <button type="button" className="lp-inline-button" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
      </p>
    );
  }
  if (state.apps.length === 0) {
    return <p className="lp-muted">No apps yet. If you build one that pays NIM, <a href="#register">register it</a> and it can be the first.</p>;
  }
  return (
    <>
      <ul className="lp-apps-list">
        {state.apps.map((a) => {
          const link = a.url && a.url.startsWith("https://") ? a.url : null;
          return (
            <li key={a.id}>
              <span className="lp-app-mark" aria-hidden="true">{Array.from(a.name)[0]?.toUpperCase()}</span>
              <span className="lp-app-text">
                <strong>{a.name}</strong>
                {link && <a href={link} target="_blank" rel="noopener noreferrer">{new URL(link).host}</a>}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="lp-muted">Building an app that pays NIM? <a href="#register">Register it</a>.</p>
    </>
  );
}

const API_BASE = new URL(import.meta.env.VITE_RAILKIT_API_URL ?? "/api", window.location.origin).href.replace(/\/$/, "");

/** The sign-up form for apps. Opens from its button, or from any link to #register. */
function RegisterApp() {
  const [open, setOpen] = useState(() => window.location.hash === "#register");
  const [form, setForm] = useState({ name: "", url: "", contact: "", addresses: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<(SaveAppKey & { contact: string }) | null>(null);

  useEffect(() => {
    const onHash = () => {
      if (window.location.hash === "#register") setOpen(true);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const field = (k: keyof typeof form) => ({
    value: form[k],
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value })),
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const key = await api.registerSaveApp({
        name: form.name.trim(),
        url: form.url.trim() || undefined,
        contact: form.contact.trim(),
        payoutAddresses: form.addresses.split(/[\n,]+/).map((a) => a.trim()).filter(Boolean),
      });
      setDone({ ...key, contact: form.contact.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Try again in a minute.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="register" className="lp-register">
      {!open && (
        <button type="button" className="lp-button" onClick={() => setOpen(true)}>Register your app</button>
      )}

      {open && !done && (
        <form className="lp-form" onSubmit={submit}>
          <h3>Register your app</h3>
          <label className="lp-field">
            <span>App name</span>
            <input required maxLength={40} autoComplete="organization" {...field("name")} />
            <small>As people see it when they pick apps. Letters, digits, spaces and . ' &amp; ! + - only.</small>
          </label>
          <label className="lp-field">
            <span>Link to your app, if it has one</span>
            <input type="url" inputMode="url" placeholder="https://" maxLength={200} {...field("url")} />
            <small>Your website or Mini App address. It's shown in the list of apps.</small>
          </label>
          <label className="lp-field">
            <span>How we can reach you</span>
            <input required maxLength={120} autoComplete="email" placeholder="Email address or Telegram handle" {...field("contact")} />
            <small>Only for the review. It's never shown.</small>
          </label>
          <label className="lp-field">
            <span>Addresses your app pays from</span>
            <textarea required rows={3} spellCheck={false} placeholder="One Nimiq address per line" {...field("addresses")} />
            <small>Up to 5. Payments from any other address aren't recorded in people's savings.</small>
          </label>
          {error && <p className="lp-error" role="alert">{error}</p>}
          <button type="submit" className="lp-button" disabled={busy}>{busy ? "Registering…" : "Register app"}</button>
        </form>
      )}

      {done && (
        <div className="lp-form lp-done" role="status">
          <h3>{done.name} is registered</h3>
          <p>It's waiting for review, and we'll reach you at {done.contact}. Once it's approved, its key starts working and it shows in the list of apps.</p>
          <p><strong>Your app key.</strong> Copy it now and keep it secret: it's shown only this once.</p>
          <CopyField text={done.apiKey} code />
          <p>
            Send it as <code>Authorization: Bearer</code> and the key with each call to the Droplets API, at <code>{API_BASE}</code>.
          </p>
        </div>
      )}
    </div>
  );
}
