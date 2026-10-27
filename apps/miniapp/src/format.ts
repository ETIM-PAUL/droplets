/** Groups a decimal string's whole part ("2500.5" → "2,500.50" for 2-decimal currencies). Never goes through floats. */
export function formatAmount(amount: string, decimals = 2): string {
  const [whole = "0", frac = ""] = amount.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (decimals === 0) return grouped;
  return `${grouped}.${frac.padEnd(decimals, "0").slice(0, decimals)}`;
}

/** Whole-number currencies don't need ".00" on screen. */
export const formatMoney = (amount: string, currency: string): string =>
  `${formatAmount(amount, amount.includes(".") ? 2 : 0)} ${currency}`;

/** Seconds as "4:05". */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
