import { describe, expect, it } from "vitest";
import { amountToMsat, isExpired, msatToSats, parseBolt11 } from "./bolt11";
import { crc16, parseEmvco } from "./emvco";
import { BITREFILL_500_KES, LUD01_LNURL, LUD01_URL, MAVAPAY_5000_KES } from "./fixtures";
import { parseLightningAddress } from "./lightning-address";
import { encodeLnurl, parseLnurl } from "./lnurl";
import { parsePaymentInput } from "./parse";

describe("amountToMsat", () => {
  it("applies each multiplier without floats", () => {
    expect(amountToMsat("1", "")).toBe("100000000000");
    expect(amountToMsat("2500", "u")).toBe("250000000");
    expect(amountToMsat("20", "m")).toBe("2000000000");
    expect(amountToMsat("10", "n")).toBe("1000");
    expect(amountToMsat("10", "p")).toBe("1");
    expect(amountToMsat("", "")).toBeNull();
  });
  it("rejects invalid amounts", () => {
    expect(amountToMsat("15", "p")).toBeNull();
    expect(amountToMsat("01", "u")).toBeNull();
  });
});

describe("msatToSats", () => {
  it("keeps sub-sat precision", () => {
    expect(msatToSats("4834000")).toBe("4834");
    expect(msatToSats("1500")).toBe("1.5");
    expect(msatToSats("1")).toBe("0.001");
  });
});

describe("parseBolt11 on real provider invoices", () => {
  it("reads the Bitrefill invoice", () => {
    const r = parseBolt11(BITREFILL_500_KES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.network).toBe("mainnet");
    expect(msatToSats(r.value.amountMsat!)).toBe("4834");
    expect(r.value.paymentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.value.timestamp).toBeGreaterThan(1_790_000_000);
    expect(isExpired(r.value, r.value.timestamp + 10)).toBe(false);
    expect(isExpired(r.value, r.value.expiresAt)).toBe(true);
  });

  it("reads the Mavapay invoice", () => {
    const r = parseBolt11(MAVAPAY_5000_KES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(msatToSats(r.value.amountMsat!)).toBe("49300");
    expect(r.value.paymentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts uppercase invoices as found in QR codes", () => {
    expect(parseBolt11(BITREFILL_500_KES.toUpperCase()).ok).toBe(true);
  });

  it("rejects a corrupted checksum", () => {
    const bad = BITREFILL_500_KES.slice(0, -1) + (BITREFILL_500_KES.endsWith("g") ? "q" : "g");
    const r = parseBolt11(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("bad_checksum");
  });

  it("rejects a truncated invoice", () => {
    expect(parseBolt11(BITREFILL_500_KES.slice(0, 80)).ok).toBe(false);
  });
});

describe("parseLightningAddress", () => {
  it("builds the LNURL-pay endpoint", () => {
    const r = parseLightningAddress("Lightning:Paul@Example.com");
    expect(r).toEqual({
      ok: true,
      value: { kind: "lightning-address", user: "paul", domain: "example.com", url: "https://example.com/.well-known/lnurlp/paul" },
    });
  });
  it("accepts phone-number addresses", () => {
    const r = parseLightningAddress("254700000000@8333.mobi");
    expect(r.ok && r.value.domain).toBe("8333.mobi");
  });
  it("rejects malformed input", () => {
    for (const s of ["paul@", "@example.com", "paul@localhost", "pa ul@example.com", "paul@example"]) {
      expect(parseLightningAddress(s).ok).toBe(false);
    }
  });
});

describe("parseLnurl", () => {
  it("decodes the LUD-01 vector", () => {
    const r = parseLnurl(LUD01_LNURL);
    expect(r.ok && r.value.url).toBe(LUD01_URL);
  });
  it("round-trips and handles the lightning: prefix", () => {
    const r = parseLnurl("lightning:" + encodeLnurl("https://pay.example.com/lnurlp/abc"));
    expect(r.ok && r.value.url).toBe("https://pay.example.com/lnurlp/abc");
  });
  it("maps lnurlp:// to https", () => {
    const r = parseLnurl("lnurlp://pay.example.com/abc");
    expect(r.ok && r.value.url).toBe("https://pay.example.com/abc");
  });
  it("refuses plain http except onion", () => {
    expect(parseLnurl(encodeLnurl("http://pay.example.com/x")).ok).toBe(false);
    expect(parseLnurl("lnurlp://abc.onion/x").ok).toBe(true);
  });
  it("rejects a damaged string", () => {
    expect(parseLnurl(LUD01_LNURL.slice(0, -2) + "QQ").ok).toBe(false);
  });
});

// Synthetic: the body is hand-built following EMV QRCPS (merchant-presented mode); CRC is computed.
const withCrc = (body: string) => {
  const head = body + "6304";
  return head + crc16(head);
};
describe("parseEmvco (synthetic samples)", () => {
  const account = "0013ke.go.example" + "010812345678"; // sub-tags 00 and 01
  const body =
    "00020101021226" + String(account.length).padStart(2, "0") + account +
    "52045411" + "5303404" + "5406250.50" + "5802KE" + "5911TEST MARKET" + "6007NAIROBI";
  const sample = withCrc(body);

  it("computes the CRC the EMVCo way", () => {
    // Standard check value for CRC-16/CCITT-FALSE.
    expect(crc16("123456789")).toBe("29B1");
  });

  it("parses merchant, amount and account scheme", () => {
    const r = parseEmvco(sample);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      initiation: "dynamic",
      merchantName: "TEST MARKET",
      merchantCity: "NAIROBI",
      countryCode: "KE",
      currencyNumeric: "404",
      amount: "250.50",
      merchantCategoryCode: "5411",
    });
    expect(r.value.merchantAccounts[0]).toMatchObject({ tag: "26", scheme: "ke.go.example" });
  });

  it("rejects a tampered amount", () => {
    const r = parseEmvco(sample.replace("250.50", "950.50"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("bad_checksum");
  });

  it("rejects non-EMVCo input and truncation", () => {
    expect(parseEmvco("hello").ok).toBe(false);
    expect(parseEmvco(sample.slice(0, 30)).ok).toBe(false);
  });

  it("allows a static QR with no amount", () => {
    const r = parseEmvco(withCrc("00020101021126" + String(account.length).padStart(2, "0") + account + "5303404" + "5802KE"));
    expect(r.ok && r.value.amount).toBeNull();
    expect(r.ok && r.value.initiation).toBe("static");
  });
});

describe("parsePaymentInput", () => {
  it("routes each input kind", () => {
    const kind = (s: string) => {
      const r = parsePaymentInput(s);
      return r.ok ? r.value.kind : r.error.code;
    };
    expect(kind(BITREFILL_500_KES)).toBe("bolt11");
    expect(kind("lightning:" + MAVAPAY_5000_KES.toUpperCase())).toBe("bolt11");
    expect(kind(LUD01_LNURL)).toBe("lnurl");
    expect(kind("paul@example.com")).toBe("lightning-address");
    expect(kind("")).toBe("empty");
    expect(kind("send me money")).toBe("unrecognised");
  });
});

import { addMoney, ceilToDecimals, compareMoney, money, mulBpsCeil } from "./money";

describe("money", () => {
  it("adds and compares exactly", () => {
    expect(addMoney(money("0.1", "NIM"), money("0.2", "NIM")).amount).toBe("0.3");
    expect(compareMoney(money("10", "KES"), money("9.99", "KES"))).toBe(1);
  });
  it("refuses to mix currencies and bad input", () => {
    expect(() => addMoney(money("1", "NIM"), money("1", "KES"))).toThrow(/mismatch/);
    expect(() => money("1e3", "NIM")).toThrow();
    expect(() => money("-1", "NIM")).toThrow();
  });
  it("rounds fees up", () => {
    expect(mulBpsCeil(money("4834", "SAT"), 100).amount).toBe("48.34");
    expect(ceilToDecimals(money("48.34", "SAT"), 0).amount).toBe("49");
    expect(ceilToDecimals(money("12.301", "KES"), 2).amount).toBe("12.31");
  });
});
