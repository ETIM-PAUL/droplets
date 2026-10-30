import { getHostNetwork, init } from "@nimiq/mini-app-sdk";
import { airtimeRoute, lendaswapExitRoute, lnurlPayRoute, payoutRoute } from "@railkit/adapters";
import { createRailkitClient } from "@railkit/client";
import {
  buildReceipt,
  CORRIDORS,
  Engine,
  machankuraAddress,
  MemoryOrderStore,
  normalizePhone,
  parsePaymentInput,
  receiptText,
  routeExecutors,
  WalletError,
  type CorridorId,
  type AirtimeOperator,
  type CountryCode,
  type EvmChain,
  type Order,
  type PayIntent,
  type RouteAdapter,
  type Step,
} from "@railkit/core";
import { createNimiqExecutor } from "@railkit/wallet-nimiq";
import { useState } from "react";
import { lendaswapClient } from "./lendaswap-client";

const api = createRailkitClient({ baseUrl: import.meta.env.VITE_RAILKIT_API_URL ?? "/api" });
const hostNetwork = () => (getHostNetwork() === "testnet" ? "testnet" : "mainnet");

/** Device checks for phases 4 to 12. Open with #spike. Payments send REAL money on mainnet. */
export function Spike() {
  const [out, setOut] = useState("");
  const [invoice, setInvoice] = useState("");
  const [to, setTo] = useState("");
  const [nim, setNim] = useState("");
  const [evm, setEvm] = useState("");
  const [chain, setChain] = useState<EvmChain>("polygon");
  const [usdc, setUsdc] = useState("");
  const [corridor, setCorridor] = useState<CorridorId>("ke-mpesa");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [bankCode, setBankCode] = useState("");
  const [bankName, setBankName] = useState("");
  const [account, setAccount] = useState("");
  const [fiat, setFiat] = useState("");
  const [mkCountry, setMkCountry] = useState<CountryCode>("KE");
  const [mkPhone, setMkPhone] = useState("");
  const [sats, setSats] = useState("");
  const [atCountry, setAtCountry] = useState<CountryCode>("KE");
  const [atPhone, setAtPhone] = useState("");
  const [operator, setOperator] = useState<{ phone: string; op: AirtimeOperator } | null>(null);
  const [atAmount, setAtAmount] = useState("");

  const report = (e: unknown) => setOut(e instanceof Error ? e.message : String(e));

  async function runStep(step: Step) {
    if (!window.confirm("This sends money from your wallet (real money on mainnet). Continue?")) return;
    try {
      const provider = await init({ timeout: 3_000 });
      const executor = routeExecutors({ "pay-lightning-invoice": createNimiqExecutor(provider), "send-nim": createNimiqExecutor(provider) });
      setOut(JSON.stringify({ ok: true, ...(await executor.execute(step)) }, null, 2));
    } catch (e) {
      setOut(JSON.stringify({ ok: false, kind: e instanceof WalletError ? e.kind : "unclassified", message: e instanceof Error ? e.message : String(e) }, null, 2));
    }
  }

  /** Quote, confirm, approve in Nimiq Pay, then poll until done. Keep the page open until it finishes. */
  async function runOrder(route: RouteAdapter, intent: PayIntent) {
    const network = hostNetwork();
    const engine = new Engine({ routes: [route], store: new MemoryOrderStore(), network });
    setOut("Getting a quote…");
    const q = await engine.quote(intent);
    if (!q.ok) return setOut(q.error.message);
    const quote = q.value[0]!;
    const ok = window.confirm(
      `Pay ${quote.send.amount} ${quote.send.currency} (fee ${quote.fee.amount}) so the recipient gets ${quote.receive.amount} ${quote.receive.currency}?\n\n${quote.notes?.join("\n") ?? ""}\n\nThis uses REAL money on mainnet.`,
    );
    if (!ok) return setOut("Cancelled. Nothing was sent.");

    const created = await engine.createOrder(quote);
    if (!created.ok) return setOut(created.error.message);
    const provider = await init({ timeout: 3_000 });
    let order: Order = await engine.approve(created.value.id, createNimiqExecutor(provider));
    const show = (o: Order) => {
      const receipt = buildReceipt(o);
      setOut(
        JSON.stringify({ state: o.state, message: o.message, refs: o.stepRefs, timeline: o.timeline.map((t) => t.to) }, null, 2) +
          (receipt ? "\n\n" + receiptText(receipt) : ""),
      );
    };
    show(order);
    for (let i = 0; i < 120 && (order.state === "processing" || order.state === "outcome_unknown"); i++) {
      await new Promise((r) => setTimeout(r, 5_000));
      order = await engine.poll(order.id);
      show(order);
    }
  }

  async function sendHome() {
    const c = CORRIDORS[corridor];
    const enabled = new Set((await api.corridors()).map((x) => x.id));
    const recipient =
      c.recipientType === "mobile-money"
        ? { type: "mobile-money" as const, phone, name, network: c.network! }
        : { type: "bank" as const, bankCode: bankCode || undefined, bankName, accountNumber: account, accountName: name };
    await runOrder(payoutRoute({ gateway: api.payouts, network: hostNetwork(), enabled }), {
      kind: "pay",
      destination: { kind: "fiat-payout", corridor, recipient },
      sourceAsset: "NIM",
      amount: { amount: fiat.trim(), currency: c.currency },
    });
  }

  async function checkAccount() {
    const r = await api.nameEnquiry(account.trim(), bankCode.trim());
    setName(r.accountName);
    setOut(`Account holder: ${r.accountName}`);
  }

  async function lookupOperator() {
    setOperator(null);
    const r = await api.lookupAirtime(atCountry, atPhone);
    setOperator({ phone: r.phone, op: r.operator });
    setOut(`${r.operator.name}: packages ${r.operator.packages.map((p) => p.value).join(", ") || "none"} ${r.operator.currency}` +
      (r.operator.range ? `; or any amount ${r.operator.range.min} to ${r.operator.range.max}` : ""));
  }

  async function topUp() {
    if (!operator) return;
    await runOrder(airtimeRoute({ gateway: api.airtime(atCountry), network: hostNetwork(), enabledCountries: new Set([atCountry]) }), {
      kind: "pay",
      destination: { kind: "airtime", phone: operator.phone, operatorId: operator.op.id, operatorName: operator.op.name },
      sourceAsset: "NIM",
      amount: { amount: atAmount.trim(), currency: operator.op.currency },
    });
  }

  async function payPhone() {
    const e164 = normalizePhone(mkPhone, mkCountry);
    if (!e164.ok) return setOut(e164.error.message);
    const dest = parsePaymentInput(machankuraAddress(e164.value));
    if (!dest.ok) return setOut(dest.error.message);
    await runOrder(lnurlPayRoute({ network: hostNetwork() }), {
      kind: "pay",
      destination: dest.value,
      sourceAsset: "NIM",
      amount: { amount: sats.trim(), currency: "SAT" },
    });
  }

  async function exitToUsdc() {
    const parsed = parsePaymentInput(evm);
    if (!parsed.ok || parsed.value.kind !== "evm-address") return setOut(parsed.ok ? "Enter a 0x wallet address." : parsed.error.message);
    await runOrder(lendaswapExitRoute({ client: lendaswapClient, network: hostNetwork() }), {
      kind: "pay",
      destination: parsed.value,
      sourceAsset: "NIM",
      targetChain: chain,
      amount: { amount: usdc.trim(), currency: "USDC" },
    });
  }

  async function probeEvm() {
    const eth = (window as unknown as { ethereum?: { request(a: { method: string }): Promise<unknown> } }).ethereum;
    if (!eth) return setOut("window.ethereum is not available here.");
    try {
      setOut(JSON.stringify({ chainId: await eth.request({ method: "eth_chainId" }), accounts: await eth.request({ method: "eth_requestAccounts" }) }, null, 2));
    } catch (e) {
      setOut(String(e instanceof Error ? e.message : JSON.stringify(e)));
    }
  }

  const field = { style: { width: "100%" } };
  const c = CORRIDORS[corridor];

  return (
    <main>
      <a href="#">Back to Errand</a>
      <h1>Device checks</h1>

      <h2>Send money home (Mavapay)</h2>
      <select value={corridor} onChange={(e) => setCorridor(e.target.value as CorridorId)}>
        {Object.values(CORRIDORS).map((x) => (
          <option key={x.id} value={x.id}>{x.label}</option>
        ))}
      </select>
      {c.recipientType === "mobile-money" ? (
        <input {...field} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Recipient phone, e.g. 0712 345 678" />
      ) : (
        <>
          <input {...field} value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="Bank name, e.g. GTBANK PLC" />
          {c.country === "NG" && <input {...field} value={bankCode} onChange={(e) => setBankCode(e.target.value)} placeholder="NIP bank code, e.g. 000013" />}
          <input {...field} value={account} onChange={(e) => setAccount(e.target.value)} placeholder="Account number" />
          {c.country === "NG" && <button onClick={() => checkAccount().catch(report)}>Check account name</button>}
        </>
      )}
      <input {...field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Recipient name as on the account" />
      <input {...field} value={fiat} onChange={(e) => setFiat(e.target.value)} placeholder={`Amount in ${c.currency}${c.minAmount ? ` (min ${c.minAmount})` : ""}`} />
      <button disabled={!fiat.trim() || !name.trim()} onClick={() => sendHome().catch(report)}>Send</button>

      <h2>Top up a phone (Bitrefill)</h2>
      <select value={atCountry} onChange={(e) => { setAtCountry(e.target.value as CountryCode); setOperator(null); }}>
        {(["KE", "NG", "GH", "ZA"] as const).map((x) => (
          <option key={x}>{x}</option>
        ))}
      </select>
      <input {...field} value={atPhone} onChange={(e) => { setAtPhone(e.target.value); setOperator(null); }} placeholder="Phone to top up" />
      <button disabled={!atPhone.trim()} onClick={() => lookupOperator().catch(report)}>Find network</button>
      {operator && (
        <>
          <input {...field} value={atAmount} onChange={(e) => setAtAmount(e.target.value)} placeholder={`Amount in ${operator.op.currency}`} />
          <button disabled={!atAmount.trim()} onClick={() => topUp().catch(report)}>Top up {operator.op.name}</button>
        </>
      )}

      <h2>Pay a phone number (Machankura)</h2>
      <select value={mkCountry} onChange={(e) => setMkCountry(e.target.value as CountryCode)}>
        {(["KE", "NG", "GH", "ZA"] as const).map((x) => (
          <option key={x}>{x}</option>
        ))}
      </select>
      <input {...field} value={mkPhone} onChange={(e) => setMkPhone(e.target.value)} placeholder="Phone of a Machankura user" />
      <input {...field} value={sats} onChange={(e) => setSats(e.target.value)} placeholder="Amount in sats" />
      <button disabled={!mkPhone.trim() || !sats.trim()} onClick={() => payPhone().catch(report)}>Pay phone</button>

      <h2>NIM to USDC (LendaSwap)</h2>
      <input {...field} value={evm} onChange={(e) => setEvm(e.target.value)} placeholder="0x… address that receives USDC" />
      <select value={chain} onChange={(e) => setChain(e.target.value as EvmChain)}>
        <option value="polygon">Polygon</option>
        <option value="arbitrum">Arbitrum</option>
        <option value="ethereum">Ethereum</option>
      </select>
      <input {...field} value={usdc} onChange={(e) => setUsdc(e.target.value)} placeholder="USDC amount, e.g. 10" />
      <button disabled={!evm.trim() || !usdc.trim()} onClick={() => exitToUsdc().catch(report)}>Convert</button>

      <h2>Lightning invoice</h2>
      <textarea rows={3} {...field} value={invoice} onChange={(e) => setInvoice(e.target.value)} placeholder="lnbc… (fixed amount)" />
      <button disabled={!invoice.trim()} onClick={() => runStep({ kind: "pay-lightning-invoice", invoice: invoice.trim() })}>Pay invoice</button>

      <h2>Send NIM</h2>
      <input {...field} value={to} onChange={(e) => setTo(e.target.value)} placeholder="NQ… address" />
      <input {...field} value={nim} onChange={(e) => setNim(e.target.value)} placeholder="amount in NIM, e.g. 1.5" />
      <button disabled={!to.trim() || !nim.trim()} onClick={() => runStep({ kind: "send-nim", to: to.trim(), amount: { amount: nim.trim(), currency: "NIM" } })}>Send NIM</button>

      <h2>EVM provider (read-only)</h2>
      <button onClick={probeEvm}>Probe window.ethereum</button>

      <pre style={{ whiteSpace: "pre-wrap" }}>{out}</pre>
    </main>
  );
}
