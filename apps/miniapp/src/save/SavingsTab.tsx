import type { SaveIntent } from "@railkit/agent";
import { useState } from "react";
import { PoolHome } from "./PoolHome";
import { SaveHome } from "./SaveHome";

/**
 * The Savings tab: Grow (a share of what apps pay you, staked in your own account) and, when it's switched on,
 * Steady and Boost (the two-sided pool).
 */
export function SavingsTab({ address, pool, start, onStarted }: { address: string | null; pool: boolean; start?: { intent: SaveIntent; notes: string[] } | null; onStarted?: () => void }) {
  const [part, setPart] = useState<"grow" | "pool">("grow");
  // A request from the chat is always about Grow.
  const showing = start ? "grow" : part;
  return (
    <>
      {pool && (
        <div className="segments" role="tablist" aria-label="Savings">
          <button type="button" role="tab" aria-selected={showing === "grow"} onClick={() => setPart("grow")}>Grow</button>
          <button type="button" role="tab" aria-selected={showing === "pool"} onClick={() => setPart("pool")}>Steady and Boost</button>
        </div>
      )}
      {showing === "grow" ? <SaveHome address={address} start={start} onStarted={onStarted} /> : (
        <>
          <header className="home-head"><h1>Steady and Boost</h1></header>
          <PoolHome address={address} />
        </>
      )}
    </>
  );
}
