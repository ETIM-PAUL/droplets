import { init } from "@nimiq/mini-app-sdk";
import { routeExecutors, WalletError, type Step } from "@railkit/core";
import { createNimiqExecutor } from "@railkit/wallet-nimiq";
import { useState } from "react";

/** Phase 4/8 device checks. Open with #spike. Runs the real wallet executors; payments send REAL money on mainnet. */
export function Spike() {
  const [invoice, setInvoice] = useState("");
  const [to, setTo] = useState("");
  const [nim, setNim] = useState("");
  const [out, setOut] = useState("");

  async function run(step: Step) {
    if (!window.confirm("This sends money from your wallet (real money on mainnet). Continue?")) return;
    try {
      const provider = await init({ timeout: 3_000 });
      const executor = routeExecutors({ "pay-lightning-invoice": createNimiqExecutor(provider), "send-nim": createNimiqExecutor(provider) });
      const result = await executor.execute(step);
      setOut(JSON.stringify({ ok: true, ...result }, null, 2));
    } catch (e) {
      const kind = e instanceof WalletError ? e.kind : "unclassified";
      setOut(JSON.stringify({ ok: false, kind, message: e instanceof Error ? e.message : String(e) }, null, 2));
    }
  }

  async function probeEvm() {
    const eth = (window as unknown as { ethereum?: { request(a: { method: string }): Promise<unknown> } }).ethereum;
    if (!eth) return setOut("window.ethereum is not available here.");
    try {
      const chainId = await eth.request({ method: "eth_chainId" });
      const accounts = await eth.request({ method: "eth_requestAccounts" });
      setOut(JSON.stringify({ chainId, accounts }, null, 2));
    } catch (e) {
      setOut(String(e instanceof Error ? e.message : JSON.stringify(e)));
    }
  }

  return (
    <main>
      <h1>Wallet spike</h1>

      <h2>Lightning invoice</h2>
      <textarea rows={3} style={{ width: "100%" }} value={invoice} onChange={(e) => setInvoice(e.target.value)} placeholder="lnbc… (fixed amount)" />
      <button disabled={!invoice.trim()} onClick={() => run({ kind: "pay-lightning-invoice", invoice: invoice.trim() })}>Pay invoice</button>

      <h2>Send NIM</h2>
      <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="NQ… address" style={{ width: "100%" }} />
      <input value={nim} onChange={(e) => setNim(e.target.value)} placeholder="amount in NIM, e.g. 1.5" style={{ width: "100%" }} />
      <button disabled={!to.trim() || !nim.trim()} onClick={() => run({ kind: "send-nim", to: to.trim(), amount: { amount: nim.trim(), currency: "NIM" } })}>Send NIM</button>

      <h2>EVM provider (read-only)</h2>
      <button onClick={probeEvm}>Probe window.ethereum</button>

      <pre>{out}</pre>
    </main>
  );
}
