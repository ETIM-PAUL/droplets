import type { SaveIntent } from "@railkit/agent";
import { useEffect, useState, type ReactNode } from "react";
import { PoolHome } from "./PoolHome";
import { SaveHome } from "./SaveHome";

interface Props {
  address: string | null;
  /** Shows Steady and Boost (the two-sided pool) beside Grow. */
  pool: boolean;
  start?: { intent: SaveIntent; notes: string[] } | null;
  onStarted?: () => void;
  /** Ask Errand, shown on Grow. */
  ask?: ReactNode;
  /** Opens Activity, for the full list of payments in. */
  onSeeAll?: () => void;
}

/**
 * Savings, Errand's home: Grow (a share of what apps pay you, staked in your own account) and, when it's
 * switched on, Steady and Boost (the two-sided pool).
 */
export function SavingsTab({ address, pool, start, onStarted, ask, onSeeAll }: Props) {
  const [part, setPart] = useState<"grow" | "pool">("grow");
  // A request from the chat is always about Grow, and Grow stays open once it's handled.
  useEffect(() => {
    if (start) setPart("grow");
  }, [start]);
  const showing = start ? "grow" : part;

  // Shown on each part's main screen, not on the screens inside it (those have a back button instead).
  const head = (
    <>
      <header className="home-head"><h1>Savings</h1></header>
      {pool && (
        <div className="segments" role="tablist" aria-label="Savings">
          <button type="button" role="tab" aria-selected={showing === "grow"} onClick={() => setPart("grow")}>Grow</button>
          <button type="button" role="tab" aria-selected={showing === "pool"} onClick={() => setPart("pool")}>Steady and Boost</button>
        </div>
      )}
    </>
  );

  return showing === "grow"
    ? <SaveHome address={address} start={start} onStarted={onStarted} head={head} ask={ask} onSeeAll={onSeeAll} />
    : <PoolHome address={address} head={head} />;
}
