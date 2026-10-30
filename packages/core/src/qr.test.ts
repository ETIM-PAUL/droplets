import { describe, expect, it } from "vitest";
import { describePayment, destinationLabel, explainRoute } from "./describe";
import { BITREFILL_500_KES, LUD01_LNURL, MAVAPAY_5000_KES } from "./fixtures";
import { parseBolt11 } from "./bolt11";
import { parseEmvco } from "./emvco";
import { findPaymentCandidates, nonPaymentKind, resolvePaymentText } from "./qr";
import type { Quote } from "./engine/types";

const inv = parseBolt11(BITREFILL_500_KES);
if (!inv.ok) throw new Error("fixture");
const ISSUED = inv.value.timestamp * 1000;

describe("resolvePaymentText", () => {
  it.each([
    ["a bare invoice", BITREFILL_500_KES, "bolt11"],
    ["lightning: prefix, upper case", `LIGHTNING:${BITREFILL_500_KES.toUpperCase()}`, "bolt11"],
    ["BIP21 with a lightning parameter", `bitcoin:bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh?amount=0.0005&lightning=${BITREFILL_500_KES}`, "bolt11"],
    ["a web link carrying an LNURL", `https://pay.example.com/?lightning=${LUD01_LNURL}`, "lnurl"],
    ["an invoice inside other text", `Pay me here: ${BITREFILL_500_KES} thanks!`, "bolt11"],
    ["a Lightning Address in a Lightning context", "⚡ Tip me: tips@getalby.com", "lightning-address"],
    ["a wallet address", "ethereum:0x52908400098527886E0F7030069857D2E4169EE7", "evm-address"],
  ])("finds %s", (_, text, kind) => {
    const r = resolvePaymentText(text);
    expect(r.status).toBe("found");
    if (r.status === "found") {
      expect(r.payment.kind).toBe(kind);
      expect(text.toLowerCase()).toContain(r.candidate.toLowerCase());
    }
  });

  it("doesn't read an ordinary email address as a Lightning Address", () => {
    expect(resolvePaymentText("Contact us: hello@shop.co.ke, open 9-5").status).toBe("none");
  });

  it("refuses to pick between two different payment requests", () => {
    const r = resolvePaymentText(`${BITREFILL_500_KES} or ${MAVAPAY_5000_KES}`);
    expect(r.status).toBe("ambiguous");
  });

  it("finds nothing in a plain link or Wi-Fi QR", () => {
    expect(resolvePaymentText("https://example.com/menu").status).toBe("none");
    expect(resolvePaymentText("WIFI:S:Cafe;T:WPA;P:secret;;").status).toBe("none");
  });

  it("only ever returns substrings of the text", () => {
    for (const c of findPaymentCandidates(`bitcoin:x?lightning=${encodeURIComponent(BITREFILL_500_KES)}`)) expect(c.length).toBeGreaterThan(0);
  });
});

describe("describePayment", () => {
  it("describes a live invoice with its amount and description", () => {
    const s = describePayment(inv.value, ISSUED + 60_000, "mainnet");
    expect(s.title).toBe("A Lightning invoice for 4,834 sats");
    expect(s.payable).toBe(true);
    expect(s.details.join(" ")).toMatch(/Expires in/);
  });

  it("explains why an invoice can't be paid", () => {
    expect(describePayment(inv.value, ISSUED + 86_400_000, "mainnet")).toMatchObject({ payable: false, why: expect.stringMatching(/new invoice/) });
    expect(describePayment(inv.value, ISSUED, "testnet")).toMatchObject({ payable: false, why: expect.stringMatching(/mainnet/) });
  });

  it("says a shop QR can't be paid yet, with the merchant and amount", () => {
    const body = "00020101021252045999530340454032505802KE5910Mama Mboga6007Nairobi";
    const crcInput = body + "6304";
    let crc = 0xffff;
    for (const ch of crcInput) {
      crc ^= ch.charCodeAt(0) << 8;
      for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    const qr = parseEmvco(crcInput + crc.toString(16).toUpperCase().padStart(4, "0"));
    if (!qr.ok) throw new Error(qr.error.message);
    const s = describePayment(qr.value, 0, "mainnet");
    expect(s).toMatchObject({ title: "A shop's payment QR for Mama Mboga", payable: false });
    expect(s.details).toContain("Amount: 250 KES");
  });
});

describe("explainRoute", () => {
  const base = { id: "q", send: { amount: "25000", currency: "SAT" }, fee: { amount: "700", currency: "SAT" }, etaSeconds: 120, expiresAt: 0, steps: [], providerRef: null };

  it("explains a bank payout step by step, naming who does what", () => {
    const q: Quote = {
      ...base,
      routeId: "fiat-payout",
      receive: { amount: "5000", currency: "NGN" },
      intent: { kind: "pay", sourceAsset: "NIM", destination: { kind: "fiat-payout", corridor: "ng-bank", recipient: { type: "bank", bankCode: "000013", bankName: "GTBANK PLC", accountNumber: "0123456789", accountName: "Ade Bello" } } },
    };
    const lines = explainRoute(q);
    expect(lines[0]).toMatch(/Nimiq Pay/);
    expect(lines[1]).toBe("Mavapay receives the bitcoin, turns it into NGN, and pays 5,000 NGN into Ade Bello's GTBANK PLC account.");
    expect(lines[2]).toMatch(/about 2 minutes.*never holds your money/);
  });

  it("explains a scanned invoice", () => {
    const q: Quote = { ...base, routeId: "lightning-invoice", receive: { amount: "4834", currency: "SAT" }, intent: { kind: "pay", sourceAsset: "NIM", destination: inv.value } };
    expect(explainRoute(q)[1]).toMatch(/whoever made the invoice/);
    expect(destinationLabel(inv.value)).toMatch(/^Bitrefill/);
  });
});

describe("nonPaymentKind", () => {
  it("names common codes that are never payments, so they stay on the phone", () => {
    expect(nonPaymentKind("WIFI:S:Cafe;T:WPA;P:secret;;")).toBe("Wi-Fi login details");
    expect(nonPaymentKind("BEGIN:VCARD\nFN:Ada\nEND:VCARD")).toBe("a contact card");
    expect(nonPaymentKind("https://example.com/menu")).toBe("a website link");
  });

  it("never hides a payment inside a link", () => {
    expect(nonPaymentKind(`https://pay.example.com/?lightning=${LUD01_LNURL}`)).toBeNull();
    expect(nonPaymentKind("Tips: kofi@blink.sv")).toBeNull();
  });
});
