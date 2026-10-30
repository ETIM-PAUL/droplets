import type { Corridor } from "@railkit/core";
import { formatMoney } from "../format";

export type Step = "where" | "who" | "amount" | "review";

interface Props {
  corridor: Corridor | null;
  name: string;
  amount: string;
  step: Step;
  onEdit?: (step: Step) => void;
}

/** "Send 2,500 KES to Jane on M-Pesa": the order as one sentence. Tapping a part goes back to that question. */
export function Sentence({ corridor, name, amount, step, onEdit }: Props) {
  const slot = (s: Step, filled: string, empty: string) => (
    <button
      type="button"
      className={`slot${filled ? "" : " empty"}${step === s ? " current" : ""}`}
      onClick={() => onEdit?.(s)}
      disabled={!onEdit}
      aria-label={filled ? `Change ${s === "where" ? "where to send" : s === "who" ? "recipient" : "amount"}: ${filled}` : undefined}
    >
      {filled || empty}
    </button>
  );
  const network = corridor ? corridor.label.split(": ")[1]! : "";
  return (
    <h2 className="sentence">
      Send {slot("amount", amount && corridor ? formatMoney(amount, corridor.currency) : "", "some money")} to{" "}
      {slot("who", name, "someone")} on {slot("where", network, "their account")}
    </h2>
  );
}
