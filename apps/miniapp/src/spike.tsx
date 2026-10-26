import { getHostNetwork, init } from "@nimiq/mini-app-sdk";
import { lendaswapExitRoute } from "@railkit/adapters";
import { Engine, MemoryOrderStore, parsePaymentInput, routeExecutors, WalletError, type EvmChain, type Order, type Step } from "@railkit/core";
import { createNimiqExecutor } from "@railkit/wallet-nimiq";
import { useState } from "react";
import { lendaswapClient } from "./lendaswap-client";

/** Phase 4/8 device checks. Open with #spike. Runs the real wallet executors; payments send REAL money on mainnet. */
export function Spike() {
  const [invoice, setInvoice] = useState("");
  const [to, setTo] = useState("");
  const [nim, setNim] = useState("");
  const [out, setOut] = useState("");
  const [evm, setEvm] = useState("");
  const [chain, setChain] = useState<EvmChain>("polygon");
  const [usdc, setUsdc] = useState("");

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

  /** NIM to USDC through LendaSwap, driven by the real engine. Keep this page open until it finishes. */
  async function exitToUsdc() {
    const parsed = parsePaymentInput(evm);
    if (!parsed.ok || parsed.value.kind !== "evm-address") return setOut(parsed.ok ? "Enter a 0x wallet address." : parsed.error.message);
    const network = getHostNetwork() === "testnet" ? "testnet" : "mainnet";
    const provider = await init({ timeout: 3_000 });
    const nimiq = createNimiqExecutor(provider);
    const engine = new Engine({
      routes: [lendaswapExitRoute({ client: lendaswapClient, network })],
      store: new MemoryOrderStore(),
      network,
    });

    const q = await engine.quote({ kind: "pay", destination: parsed.value, sourceAsset: "NIM", targetChain: chain, amount: { amount: usdc.trim(), currency: "USDC" } });
    if (!q.ok) return setOut(q.error.message);
    const quote = q.value[0]!;
    const ok = window.confirm(
      `Send ${quote.send.amount} sats' worth (fee ${quote.fee.amount}) to receive ${quote.receive.amount} USDC on ${chain}?\n\n${quote.notes?.join("\n")}\n\nThis uses REAL money on mainnet.`,
    );
    if (!ok) return setOut("Cancelled. Nothing was sent.");

    const created = await engine.createOrder(quote);
    if (!created.ok) return setOut(created.error.message);
    let order: Order = await engine.approve(created.value.id, nimiq);
    const show = (o: Order) => setOut(JSON.stringify({ state: o.state, message: o.message, refs: o.stepRefs, timeline: o.timeline.map((t) => t.to) }, null, 2));
    show(order);
    for (let i = 0; i < 120 && (order.state === "processing" || order.state === "outcome_unknown"); i++) {
      await new Promise((r) => setTimeout(r, 5_000));
      order = await engine.poll(order.id);
      show(order);
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

      <h2>NIM to USDC (LendaSwap)</h2>
      <input value={evm} onChange={(e) => setEvm(e.target.value)} placeholder="0x… address that receives USDC" style={{ width: "100%" }} />
      <select value={chain} onChange={(e) => setChain(e.target.value as EvmChain)}>
        <option value="polygon">Polygon</option>
        <option value="arbitrum">Arbitrum</option>
        <option value="ethereum">Ethereum</option>
      </select>
      <input value={usdc} onChange={(e) => setUsdc(e.target.value)} placeholder="USDC amount, e.g. 10" style={{ width: "100%" }} />
      <button disabled={!evm.trim() || !usdc.trim()} onClick={() => exitToUsdc().catch((e) => setOut(String(e)))}>Convert</button>

      <h2>EVM provider (read-only)</h2>
      <button onClick={probeEvm}>Probe window.ethereum</button>

      <pre>{out}</pre>
    </main>
  );
}
