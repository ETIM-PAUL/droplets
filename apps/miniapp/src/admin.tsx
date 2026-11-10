import "@fontsource-variable/mulish";
import { lunaToNimString } from "@railkit/core";
import { StrictMode, useCallback, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { formatMoney } from "./format";
import "./styles.css";

/** The admin page for apps that save with Droplets: review, approve, edit, replace keys, remove, add. */

interface Usage { payments: number; people: number; savedLuna: string; fromSpendLuna: string; walletLuna: string; pickedBy: number; lastPaymentAt: number | null }
interface AdminApp { id: string; name: string; url: string | null; contact: string | null; payoutAddresses: string[]; pending: boolean; createdAt: number; usage: Usage }

const BASE = (import.meta.env.VITE_RAILKIT_API_URL ?? "/api").replace(/\/$/, "");
const TOKEN_KEY = "droplets-admin-token";
const store = {
  get: () => { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set: (v: string) => { try { sessionStorage.setItem(TOKEN_KEY, v); } catch { /* the token then lasts only until a reload */ } },
  clear: () => { try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* nothing stored */ } },
};

class Unauthorized extends Error {}

async function call<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("Can't reach the server. It may be waking up: try again in a minute.");
  }
  const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  // The API answers 404 to a wrong token, so nobody can tell the admin routes exist.
  if (res.status === 404 && path.startsWith("/v1/admin/save/apps") && !path.slice(19).includes("/") && method === "GET") throw new Unauthorized();
  if (!res.ok) throw new Error(data?.error?.message ?? "The server had a problem. Try again in a minute.");
  return data as T;
}

const nim = (luna: string) => formatMoney(lunaToNimString(BigInt(luna)), "NIM");
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function Admin() {
  const [token, setToken] = useState<string | null>(store.get);
  const [apps, setApps] = useState<AdminApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const signOut = useCallback((why?: string) => {
    store.clear();
    setToken(null);
    setApps(null);
    setError(why ?? null);
  }, []);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setApps((await call<{ apps: AdminApp[] }>(token, "GET", "/v1/admin/save/apps")).apps);
      setError(null);
    } catch (e) {
      if (e instanceof Unauthorized) signOut("That token isn't right.");
      else setError(e instanceof Error ? e.message : "Couldn't load the apps.");
    }
  }, [token, signOut]);

  useEffect(() => { void load(); }, [load]);

  if (!token) return <SignIn error={error} onToken={(t) => { store.set(t); setToken(t); setError(null); }} />;

  const waiting = (apps ?? []).filter((a) => a.pending);
  const live = (apps ?? []).filter((a) => !a.pending);
  return (
    <div className="adm">
      <header className="adm-top">
        <h1>Droplets admin</h1>
        <div className="adm-top-actions">
          <button type="button" className="secondary" onClick={() => void load()}>Refresh</button>
          <button type="button" className="secondary" onClick={() => signOut()}>Sign out</button>
        </div>
      </header>
      {error && <p className="alert" role="alert">{error}</p>}
      {apps === null && !error && <p className="hint">Loading apps…</p>}
      {apps !== null && (
        <>
          <section aria-labelledby="adm-waiting">
            <h2 id="adm-waiting">Waiting for review {waiting.length > 0 && <span className="adm-count">{waiting.length}</span>}</h2>
            {waiting.length === 0 ? <p className="hint">Nothing waiting. New sign-ups from the landing page show up here.</p> : waiting.map((a) => <AppCard key={a.id} app={a} token={token} onChanged={load} />)}
          </section>
          <section aria-labelledby="adm-live">
            <h2 id="adm-live">Approved apps <span className="adm-count">{live.length}</span></h2>
            {live.length === 0 ? <p className="hint">No approved apps yet.</p> : live.map((a) => <AppCard key={a.id} app={a} token={token} onChanged={load} />)}
          </section>
          <AddApp token={token} onChanged={load} />
        </>
      )}
    </div>
  );
}

function SignIn({ error, onToken }: { error: string | null; onToken: (t: string) => void }) {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => { e.preventDefault(); if (value.trim()) onToken(value.trim()); };
  return (
    <form className="adm adm-signin" onSubmit={submit}>
      <h1>Droplets admin</h1>
      <p className="hint">Paste the admin token. It's kept only until you close this tab.</p>
      <label className="lp-field">
        <span>Admin token</span>
        <input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      {error && <p className="lp-error" role="alert">{error}</p>}
      <button type="submit" className="primary" disabled={!value.trim()}>Sign in</button>
    </form>
  );
}

/** One app: its details and usage, with the actions that fit its state. */
function AppCard({ app, token, onChanged }: { app: AdminApp; token: string; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"remove" | "key" | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); await onChanged(); } catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); } finally { setBusy(false); }
  };
  const u = app.usage;

  return (
    <article className="adm-card">
      <div className="adm-card-head">
        <h3>{app.name}</h3>
        <span className={`adm-badge${app.pending ? " pending" : ""}`}>{app.pending ? "Waiting" : "Approved"}</span>
      </div>
      <dl className="adm-details">
        <dt>Link</dt><dd>{app.url ? <a href={app.url} target="_blank" rel="noopener noreferrer">{app.url}</a> : "None"}</dd>
        <dt>Contact</dt><dd>{app.contact ?? "None"}</dd>
        <dt>Signed up</dt><dd>{day(app.createdAt)}</dd>
        <dt>Pays from</dt><dd className="adm-addrs">{app.payoutAddresses.map((a) => <code key={a}>{a}</code>)}</dd>
      </dl>
      {!app.pending && (
        <ul className="adm-usage" aria-label={`${app.name} usage`}>
          <li><strong>{u.payments}</strong><span>payments</span></li>
          <li><strong>{u.people}</strong><span>people</span></li>
          <li><strong>{nim(u.savedLuna)}</strong><span>saved{u.fromSpendLuna !== "0" ? `, ${nim(u.fromSpendLuna)} on top of purchases` : ""}</span></li>
          <li><strong>{nim(u.walletLuna)}</strong><span>paid to wallets</span></li>
          <li><strong>{u.pickedBy}</strong><span>picked it</span></li>
          <li><strong>{u.lastPaymentAt ? day(u.lastPaymentAt) : "Never"}</strong><span>last payment</span></li>
        </ul>
      )}

      {editing && <EditForm app={app} busy={busy} onCancel={() => setEditing(false)} onSave={(fields) => run(async () => { await call(token, "PATCH", `/v1/admin/save/apps/${app.id}`, fields); setEditing(false); })} />}

      {newKey && (
        <div className="adm-key" role="status">
          <p><strong>New key.</strong> Send it to the developer now: it's shown only this once, and the old key has stopped working.</p>
          <div className="lp-address"><code>{newKey}</code><button type="button" onClick={() => void navigator.clipboard?.writeText(newKey)}>Copy</button></div>
          <button type="button" className="secondary" onClick={() => setNewKey(null)}>Done</button>
        </div>
      )}

      {confirm === "remove" && <Confirm text={`Remove ${app.name}? Its key stops working and it leaves the list. People's savings aren't touched.`} yes="Remove app" busy={busy} danger onNo={() => setConfirm(null)} onYes={() => run(async () => { await call(token, "DELETE", `/v1/admin/save/apps/${app.id}`); })} />}
      {confirm === "key" && <Confirm text={`Replace ${app.name}'s key? The current key stops working at once.`} yes="Replace key" busy={busy} onNo={() => setConfirm(null)} onYes={() => run(async () => { setNewKey((await call<{ apiKey: string }>(token, "POST", `/v1/admin/save/apps/${app.id}/key`)).apiKey); setConfirm(null); })} />}

      {error && <p className="lp-error" role="alert">{error}</p>}
      {!confirm && !editing && (
        <div className="adm-actions">
          {app.pending && <button type="button" className="primary" disabled={busy} onClick={() => void run(async () => { await call(token, "POST", `/v1/admin/save/apps/${app.id}/approve`); })}>Approve</button>}
          <button type="button" className="secondary" onClick={() => setEditing(true)}>Edit</button>
          <button type="button" className="secondary" onClick={() => setConfirm("key")}>New key</button>
          <button type="button" className="secondary adm-danger" onClick={() => setConfirm("remove")}>Remove</button>
        </div>
      )}
    </article>
  );
}

function Confirm({ text, yes, busy, danger, onYes, onNo }: { text: string; yes: string; busy: boolean; danger?: boolean; onYes: () => void; onNo: () => void }) {
  return (
    <div className="adm-confirm" role="alertdialog" aria-label={text}>
      <p>{text}</p>
      <div className="adm-actions">
        <button type="button" className={`secondary${danger ? " adm-danger" : ""}`} disabled={busy} onClick={onYes}>{busy ? "Working…" : yes}</button>
        <button type="button" className="secondary" disabled={busy} onClick={onNo}>Cancel</button>
      </div>
    </div>
  );
}

const toAddresses = (text: string) => text.split(/[\n,]+/).map((a) => a.trim()).filter(Boolean);

function EditForm({ app, busy, onSave, onCancel }: { app: AdminApp; busy: boolean; onSave: (f: Record<string, unknown>) => void; onCancel: () => void }) {
  const [f, setF] = useState({ name: app.name, url: app.url ?? "", contact: app.contact ?? "", addresses: app.payoutAddresses.join("\n") });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = (e: FormEvent) => { e.preventDefault(); onSave({ name: f.name, url: f.url, contact: f.contact, payoutAddresses: toAddresses(f.addresses) }); };
  return (
    <form className="adm-edit" onSubmit={submit}>
      <label className="lp-field"><span>Name</span><input required maxLength={40} value={f.name} onChange={set("name")} /></label>
      <label className="lp-field"><span>Link</span><input type="url" placeholder="https://" maxLength={200} value={f.url} onChange={set("url")} /></label>
      <label className="lp-field"><span>Contact</span><input maxLength={120} value={f.contact} onChange={set("contact")} /></label>
      <label className="lp-field"><span>Payout addresses, one per line</span><textarea required rows={3} spellCheck={false} value={f.addresses} onChange={set("addresses")} /></label>
      <div className="adm-actions">
        <button type="submit" className="primary" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** Add an app the team set up itself: approved at once, key shown once. */
function AddApp({ token, onChanged }: { token: string; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", url: "", contact: "", addresses: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ name: string; apiKey: string } | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ name: string; apiKey: string }>(token, "POST", "/v1/admin/save/apps", { name: f.name, url: f.url, contact: f.contact, payoutAddresses: toAddresses(f.addresses) });
      setMade(r);
      setF({ name: "", url: "", contact: "", addresses: "" });
      setOpen(false);
      await onChanged();
    } catch (err) { setError(err instanceof Error ? err.message : "That didn't work."); } finally { setBusy(false); }
  };
  return (
    <section aria-labelledby="adm-add">
      <h2 id="adm-add">Add an app</h2>
      {made && (
        <div className="adm-key" role="status">
          <p><strong>{made.name} is added and approved.</strong> Send its key to the developer now: it's shown only this once.</p>
          <div className="lp-address"><code>{made.apiKey}</code><button type="button" onClick={() => void navigator.clipboard?.writeText(made.apiKey)}>Copy</button></div>
          <button type="button" className="secondary" onClick={() => setMade(null)}>Done</button>
        </div>
      )}
      {!open ? <button type="button" className="secondary" onClick={() => setOpen(true)}>Add an app</button> : (
        <form className="adm-edit" onSubmit={submit}>
          <label className="lp-field"><span>Name</span><input required maxLength={40} value={f.name} onChange={set("name")} /></label>
          <label className="lp-field"><span>Link, if it has one</span><input type="url" placeholder="https://" maxLength={200} value={f.url} onChange={set("url")} /></label>
          <label className="lp-field"><span>Contact, if you have one</span><input maxLength={120} value={f.contact} onChange={set("contact")} /></label>
          <label className="lp-field"><span>Payout addresses, one per line</span><textarea required rows={3} spellCheck={false} value={f.addresses} onChange={set("addresses")} /></label>
          {error && <p className="lp-error" role="alert">{error}</p>}
          <div className="adm-actions">
            <button type="submit" className="primary" disabled={busy}>{busy ? "Adding…" : "Add and approve"}</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Admin /></StrictMode>);
