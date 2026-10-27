// Decimal-string money arithmetic. Amounts are never floats; everything is scaled to 18 decimals in bigint.
const SCALE = 18;
const DECIMAL = /^\d+(\.\d+)?$/;

export interface Money {
  /** Non-negative decimal string, e.g. "2500" or "12.50". */
  amount: string;
  /** Currency or asset code, e.g. "KES", "NIM", "SAT". */
  currency: string;
}

export const isDecimal = (s: string): boolean => DECIMAL.test(s) && (s.split(".")[1]?.length ?? 0) <= SCALE;

export function toScaled(amount: string): bigint {
  if (!isDecimal(amount)) throw new RangeError(`Invalid decimal amount: ${amount}`);
  const [whole, frac = ""] = amount.split(".");
  return BigInt(whole! + frac.padEnd(SCALE, "0"));
}

export function fromScaled(n: bigint): string {
  const s = n.toString().padStart(SCALE + 1, "0");
  const whole = s.slice(0, -SCALE);
  const frac = s.slice(-SCALE).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function same(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new RangeError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
}

export const money = (amount: string, currency: string): Money => ({ amount: fromScaled(toScaled(amount)), currency });

export function addMoney(a: Money, b: Money): Money {
  same(a, b);
  return { amount: fromScaled(toScaled(a.amount) + toScaled(b.amount)), currency: a.currency };
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  same(a, b);
  const x = toScaled(a.amount);
  const y = toScaled(b.amount);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Multiply by basis points (100 bps = 1%), rounding up so a fee is never understated. */
export function mulBpsCeil(a: Money, bps: number): Money {
  const n = toScaled(a.amount) * BigInt(bps);
  const q = (n + 9_999n) / 10_000n;
  return { amount: fromScaled(q), currency: a.currency };
}

/** Round up to `decimals` places (0 for whole sats, 2 for cents), so fees land on a payable amount. */
export function ceilToDecimals(a: Money, decimals: number): Money {
  const unit = 10n ** BigInt(SCALE - decimals);
  const n = toScaled(a.amount);
  return { amount: fromScaled(((n + unit - 1n) / unit) * unit), currency: a.currency };
}

/** "1234567.5" → "1,234,567.5". Display only; keeps the digits exactly as given. */
export function groupDigits(amount: string): string {
  const [whole = "0", frac] = amount.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac === undefined ? grouped : `${grouped}.${frac}`;
}
