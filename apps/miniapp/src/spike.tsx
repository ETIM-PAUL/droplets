import { init, NimiqProviderError } from "@nimiq/mini-app-sdk";
import { useState } from "react";

/** Phase 4 spike: pays a real Lightning invoice so we can record limits, fees and errors. Open with #spike. */
export function Spike() {
  const [invoice, setInvoice] = useState("");
  const [out, setOut] = useState("");

  async function pay() {
    if (!window.confirm("This sends REAL money from your wallet. Continue?")) return;
    try {
      const nimiq = await init({ timeout: 3_000 });
      const result = await nimiq.payLightningInvoice({ invoice: invoice.trim() });
      setOut(JSON.stringify(result, null, 2));
    } catch (e) {
      setOut(
        NimiqProviderError.is(e)
          ? JSON.stringify({ type: e.type, message: e.message, data: e.data }, null, 2)
          : String(e),
      );
    }
  }

  return (
    <main>
      <h1>payLightningInvoice spike</h1>
      <textarea rows={4} style={{ width: "100%" }} value={invoice} onChange={(e) => setInvoice(e.target.value)} placeholder="lnbc… (fixed amount)" />
      <button onClick={pay} disabled={!invoice.trim()}>Pay invoice</button>
      <pre>{out}</pre>
    </main>
  );
}
