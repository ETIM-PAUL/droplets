import type { Bank } from "./intent";

const FILLER = new Set(["bank", "plc", "limited", "ltd", "nigeria", "nig", "of", "for", "and", "the", "microfinance", "mfb"]);
const STOP_IN_ACRONYM = new Set(["of", "for", "and", "the"]);

/**
 * Banks people name with one word. Elsewhere in a sentence a single word only counts as a bank when the
 * sentence also says "bank" (or MFB), so "send money to Grace" doesn't pick "Money Box" or "Grace MFB".
 */
const WELL_KNOWN = new Set([
  "access", "gtbank", "zenith", "uba", "fcmb", "opay", "palmpay", "kuda", "moniepoint", "wema", "fidelity", "sterling",
  "ecobank", "polaris", "keystone", "providus", "jaiz", "globus", "lotus", "parallex", "union", "heritage", "stanbic",
  "titan", "taj", "first", "unity", "suntrust", "premium", "signature", "optimus", "vfd", "carbon", "paycom",
]);

/** What people say, rewritten to how the provider's list names the bank. */
const ALIASES: [RegExp, string][] = [
  [/ (gt bank|gt|gtb|gtco|guaranty trust|guaranty trust bank|guaranty) /g, " gtbank "],
  [/ firstbank /g, " first bank "],
  [/ stanbic /g, " stanbic ibtc "],
  [/ moniepoint mfb /g, " moniepoint "],
];

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
const core = (s: string) => words(s).filter((w) => !FILLER.has(w)).join(" ");
/** "United Bank For Africa" → "uba", "First City Monument Bank" → "fcmb". */
const initials = (s: string) => words(s).filter((w) => !STOP_IN_ACRONYM.has(w)).map((w) => w[0]).join("");

export interface BankMatch {
  bank?: Bank;
  /** More than one bank fits; the user picks. */
  choices?: Bank[];
}

/**
 * Finds the bank a sentence names, against the provider's list. Microfinance banks often share a word
 * with big banks, so the longest whole-name match wins, and a tie becomes a choice for the user.
 */
export function matchBank(text: string, banks: readonly Bank[], o: { answer?: boolean } = {}): BankMatch {
  let t = ` ${words(text).join(" ")} `;
  for (const [re, to] of ALIASES) t = t.replace(re, to);
  const tWords = new Set(t.trim().split(" "));
  // In an answer to "Which bank?" every word is about the bank; in a sentence, only some are.
  const loose = o.answer || /\b(bank|mfb|microfinance|psb)\b/i.test(text);

  let best = 0;
  const hits = new Map<string, Bank>();
  for (const b of banks) {
    const name = core(b.name);
    if (!name) continue;
    let score = 0;
    const first = name.split(" ")[0]!;
    if (!loose && !WELL_KNOWN.has(first) && !WELL_KNOWN.has(initials(b.name))) continue;
    if (name.length >= 3 && t.includes(` ${name} `)) score = 100 + name.length;
    else {
      const ini = initials(b.name);
      if (ini.length >= 3 && tWords.has(ini)) score = 80;
      // A distinctive first word ("stanbic", "zenith") still names the bank when the rest is left off.
      else if (first.length >= 4 && tWords.has(first)) score = 10;
    }
    if (score === 0 || score < best) continue;
    if (score > best) {
      best = score;
      hits.clear();
    }
    hits.set(b.code, { name: b.name.trim(), code: b.code });
  }
  if (hits.size === 0) return {};
  if (hits.size === 1) return { bank: [...hits.values()][0] };
  return { choices: [...hits.values()].slice(0, 5) };
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

/**
 * When nothing matches outright ("GT", "zenit", "first monument"), the closest banks to offer as choices:
 * names or initials that start with what was typed, then near-misses in spelling. Big banks come first.
 */
export function suggestBanks(query: string, banks: readonly Bank[], limit = 5): Bank[] {
  const q = words(query).filter((w) => !FILLER.has(w) && !["my", "to", "send", "account"].includes(w));
  if (!q.length) return [];
  const scored = new Map<string, { bank: Bank; score: number; len: number }>();
  for (const b of banks) {
    const name = core(b.name);
    const nws = name.split(" ").filter(Boolean);
    const ini = initials(b.name);
    let score = 0;
    for (const w of q) {
      if (nws.some((n) => n.startsWith(w)) || (w.length >= 2 && ini.startsWith(w))) score += 3;
      else if (w.length >= 4 && nws.some((n) => distance(n, w) <= (w.length > 6 ? 2 : 1))) score += 2;
    }
    if (!score) continue;
    if (WELL_KNOWN.has(nws[0] ?? "") || WELL_KNOWN.has(ini)) score += 1;
    const prev = scored.get(b.code);
    if (!prev || prev.score < score) scored.set(b.code, { bank: { name: b.name.trim(), code: b.code }, score, len: name.length });
  }
  return [...scored.values()].sort((a, b) => b.score - a.score || a.len - b.len).slice(0, limit).map((x) => x.bank);
}
