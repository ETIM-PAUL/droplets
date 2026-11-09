// What a change from Ask Droplets will do, worked out from the user's savings. Pure, so it's tested on its own.
import type { SaveIntent } from "@railkit/agent";
import type { SaveMe } from "@railkit/client";
import { checkWithdrawal, lunaToNimString, nimStringToLuna, type StakerState } from "@railkit/core";
import { formatMoney } from "../format";

const nim = (luna: bigint) => formatMoney(lunaToNimString(luna), "NIM");

/** A change the chat can confirm in one tap: everything it needs is known, and nothing about it is in doubt. */
export const canConfirm = (s: SaveIntent): boolean =>
  (s.action === "rule" && s.savePercent !== undefined) || (s.action === "add" && s.nim !== undefined) || (s.action === "withdraw" && (s.nim !== undefined || s.all === true)) || s.action === "revoke";

/** What the Confirm button will do, worked out from the user's savings. `form` means it needs the full screen instead. */
export type Plan =
  | { kind: "rule"; savePercent: number; title: string; detail: string }
  | { kind: "add"; luna: bigint; title: string; detail: string }
  | { kind: "withdraw"; luna: bigint; newActive: bigint; title: string; detail: string }
  | { kind: "revoke"; title: string; detail: string }
  | { kind: "form"; why: string };

export function plan(s: SaveIntent, me: SaveMe): Plan {
  const g = me.grow;
  switch (s.action) {
    case "rule": {
      const p = s.savePercent!;
      if (!Number.isInteger(p) || p < 0 || p > 100) return { kind: "form", why: "The share to save has to be a whole percent from 0 to 100." };
      if (!me.code && !g) return { kind: "form", why: "Your savings aren't open yet. Open them first, then choose your share." };
      return {
        kind: "rule", savePercent: p, title: `Save ${p}% of what apps pay you`,
        detail: me.savePercent === null ? "This also gives you your save code." : `Now ${me.savePercent}%. Your other rules stay as they are.`,
      };
    }
    case "add": {
      const luna = nimStringToLuna(s.nim ?? "");
      if (!luna.ok || luna.value <= 0n) return { kind: "form", why: "That amount didn't read clearly." };
      if (!g) return { kind: "form", why: "Your savings aren't open yet, so this opens them, with at least 100 NIM." };
      return { kind: "add", luna: luna.value, title: `Add ${nim(luna.value)} to your savings`, detail: `It moves from your Nimiq Pay wallet. You'll have ${nim(BigInt(g.active) + BigInt(g.inactive) + luna.value)} saved.` };
    }
    case "withdraw": {
      if (!g || BigInt(g.active) === 0n) return { kind: "form", why: "There's nothing in your savings to withdraw right now." };
      const staker: StakerState = { active: BigInt(g.active), inactive: BigInt(g.inactive), inactiveFrom: g.inactiveFrom, retired: BigInt(g.retired), delegation: g.delegation };
      const luna = s.all ? staker.active : nimStringToLuna(s.nim ?? "");
      const amount = typeof luna === "bigint" ? luna : luna.ok ? luna.value : null;
      if (amount === null) return { kind: "form", why: "That amount didn't read clearly." };
      const check = checkWithdrawal(staker, amount);
      if (!check.ok) return { kind: "form", why: check.error.message };
      return {
        kind: "withdraw", luna: amount, newActive: check.value.newActive, title: `Withdraw ${nim(amount)} from your savings`,
        detail: "It's ready in 12 to 24 hours, when Nimiq releases staked NIM. Then you finish it on Home.",
      };
    }
    case "revoke":
      if (!me.code) return { kind: "form", why: "You don't have a save code to turn off." };
      return { kind: "revoke", title: `Turn off your save code ${me.code}`, detail: "Apps that have it will pay your wallet instead. Your savings stay where they are." };
    default:
      return { kind: "form", why: "" };
  }
}
