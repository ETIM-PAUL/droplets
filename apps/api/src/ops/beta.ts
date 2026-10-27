import { createHmac, timingSafeEqual } from "node:crypto";
import type { OpsStore } from "./store";

export interface BetaConfig {
  /** Invite code → who it was given to (for the team's eyes only). */
  invites: Map<string, string>;
  secret: string;
  /** Per-order and rolling 24-hour caps, in sats, per invite. */
  maxSatsPerOrder: bigint;
  maxSatsPerDay: bigint;
  sessionDays?: number;
}

/** "PAUL-7Q2=Paul, MAMA-K3=Paul's mum" → map. Codes are case-insensitive. */
export function parseInvites(spec: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of (spec ?? "").split(",")) {
    const [code, label] = part.split("=").map((s) => s.trim());
    if (code) m.set(code.toUpperCase(), label || code.toUpperCase());
  }
  return m;
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const sign = (payload: string, secret: string) => createHmac("sha256", secret).update(payload).digest("base64url");

/** A session token is "<invite>.<issuedAt>.<hmac>": stateless, and revoked by removing the invite. */
export function issueSession(invite: string, cfg: BetaConfig, now: number): string {
  const payload = `${b64(invite)}.${now}`;
  return `${payload}.${sign(payload, cfg.secret)}`;
}

export function verifySession(token: string | undefined, cfg: BetaConfig, now: number): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [inv, iat, mac] = parts as [string, string, string];
  const expected = sign(`${inv}.${iat}`, cfg.secret);
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const invite = Buffer.from(inv, "base64url").toString();
  if (!cfg.invites.has(invite)) return null; // removed from the list: access ends
  if (!/^\d+$/.test(iat) || now - Number(iat) > (cfg.sessionDays ?? 30) * 86_400_000) return null;
  return invite;
}

/** Null when the quote is within the tester's limits, otherwise the reason to show them. */
export async function overLimit(invite: string, sats: bigint, cfg: BetaConfig, store: OpsStore, now: number): Promise<string | null> {
  if (sats > cfg.maxSatsPerOrder) {
    return `During the beta, one payment can be up to ${cfg.maxSatsPerOrder.toLocaleString("en")} sats. Send a smaller amount.`;
  }
  const recent = await store.listSince(now - 86_400_000);
  // Count anything that may have moved money: paid, delivered, or still payable.
  const used = recent
    .filter((o) => o.invite === invite && (o.state === "paid" || o.state === "done" || (o.state === "awaiting_payment" && o.expiresAt > now)))
    .reduce((sum, o) => sum + BigInt(o.sats), 0n);
  if (used + sats > cfg.maxSatsPerDay) {
    return `During the beta, you can send up to ${cfg.maxSatsPerDay.toLocaleString("en")} sats in 24 hours. Try again tomorrow or send less.`;
  }
  return null;
}
