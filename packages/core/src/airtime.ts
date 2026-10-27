import { fromScaled, isDecimal, toScaled, type Money } from "./money";
import { fail, ok, type Result } from "./result";

/** An airtime top-up for a phone. The operator comes from a lookup, never from free text. */
export interface AirtimeDestination {
  kind: "airtime";
  /** E.164. */
  phone: string;
  operatorId: string;
  operatorName?: string;
}

export interface AirtimeOperator {
  id: string;
  name: string;
  /** ISO country code as the provider reports it. */
  country: string;
  currency: string;
  /** Fixed denominations. `priceSats` is the provider's indicative price; the invoice is what counts. */
  packages: { id: string; value: string; priceSats: string }[];
  /** Flexible amounts, in the operator's currency; null when only packages are sold. */
  range: { min: string; max: string; step: string } | null;
}

/** Checks an amount against an operator's packages and range. Returns the package to buy, if one matches. */
export function chooseAirtimeAmount(op: AirtimeOperator, amount: Money): Result<{ packageId: string | null; value: string }> {
  if (amount.currency !== op.currency) return fail("unsupported", `${op.name} tops up in ${op.currency}.`);
  if (!isDecimal(amount.amount) || toScaled(amount.amount) === 0n) return fail("bad_amount", "Enter an amount greater than zero.");
  const value = fromScaled(toScaled(amount.amount));

  const pkg = op.packages.find((p) => toScaled(p.value) === toScaled(value));
  if (pkg) return ok({ packageId: pkg.id, value });

  if (op.range) {
    const v = toScaled(value);
    const min = toScaled(op.range.min);
    const max = toScaled(op.range.max);
    const step = toScaled(op.range.step);
    if (v >= min && v <= max && (step === 0n || (v - min) % step === 0n)) return ok({ packageId: null, value });
    const stepNote = op.range.step === "1" ? "" : ` in steps of ${op.range.step}`;
    return fail("bad_amount", `${op.name} tops up between ${op.range.min} and ${op.range.max} ${op.currency}${stepNote}.`);
  }
  const options = op.packages.map((p) => p.value).join(", ");
  return fail("bad_amount", `${op.name} sells these amounts only: ${options} ${op.currency}.`);
}
