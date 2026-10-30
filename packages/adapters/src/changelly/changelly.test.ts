import { generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createChangellyFiatApi, rampState } from "./api";

// Changelly issues keys as base64 of a PKCS#1 PEM; make a throwaway pair in that shape.
const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    priv: Buffer.from(privateKey.export({ type: "pkcs1", format: "pem" })).toString("base64"),
    pub: Buffer.from(publicKey.export({ type: "pkcs1", format: "pem" })).toString("base64"),
    privateKey,
    publicKey,
  };
};
const ours = pair();
const theirs = pair();

function setup(reply: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = reply(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  });
  const api = createChangellyFiatApi({ publicKey: "pk_test", privateKey: ours.priv, callbackPublicKey: theirs.pub, fetch: fetch as unknown as typeof globalThis.fetch });
  return { api, calls };
}

const headers = (init: RequestInit) => init.headers as Record<string, string>;

describe("Changelly Fiat API", () => {
  it("signs the full URL plus the JSON body, as Changelly's SDK does", async () => {
    const { api, calls } = setup(() => ({ body: { orderId: "o1", redirectUrl: "https://pay.example/o1" } }));
    await api.createOrder({ externalOrderId: "e1", externalUserId: "u1", providerCode: "moonpay", currencyFrom: "NGN", currencyTo: "NIM", amountFrom: "10000", country: "NG", walletAddress: "NQ07 0000 0000 0000 0000 0000 0000 0000 0000" });
    const { url, init } = calls[0]!;
    expect(url).toBe("https://fiat-api.changelly.com/v1/orders");
    expect(headers(init)["X-Api-Key"]).toBe("pk_test");
    const payload = Buffer.from(url + String(init.body));
    expect(verify("sha256", payload, ours.publicKey, Buffer.from(headers(init)["X-Api-Signature"]!, "base64"))).toBe(true);
  });

  it("signs GET requests over the URL with its query and an empty body", async () => {
    const { api, calls } = setup(() => ({ body: [] }));
    await api.offers({ currencyFrom: "NGN", currencyTo: "NIM", amountFrom: "10000", country: "NG" });
    const { url, init } = calls[0]!;
    expect(url).toBe("https://fiat-api.changelly.com/v1/offers?currencyFrom=NGN&currencyTo=NIM&amountFrom=10000&country=NG");
    expect(init.body).toBeUndefined();
    expect(verify("sha256", Buffer.from(url + "{}"), ours.publicKey, Buffer.from(headers(init)["X-Api-Signature"]!, "base64"))).toBe(true);
  });

  it("returns offers best first and explains providers that can't serve", async () => {
    const { api } = setup(() => ({
      body: [
        { providerCode: "banxa", rate: "0.0002", fee: "500", amountFrom: "10000", amountExpectedTo: "1900000", paymentMethodOffers: [{ method: "card", methodName: "Card", amountExpectedTo: "1900000", fee: "500" }] },
        { providerCode: "moonpay", rate: "0.0002", fee: "300", amountFrom: "10000", amountExpectedTo: "2100000", paymentMethodOffers: [] },
        { providerCode: "wert", errorType: "limits", errorMessage: "min 50 USD", errorDetails: null },
      ],
    }));
    const r = await api.offers({ currencyFrom: "NGN", currencyTo: "NIM", amountFrom: "10000", country: "NG" });
    expect(r.offers.map((o) => o.providerCode)).toEqual(["moonpay", "banxa"]);
    expect(r.offers[1]!.methods[0]).toEqual({ method: "card", methodName: "Card", amountExpectedTo: "1900000", fee: "500" });
    expect(r.errors).toEqual([{ providerCode: "wert", errorType: "limits", message: expect.stringMatching(/outside/) }]);
  });

  it("turns API errors into plain messages", async () => {
    const { api } = setup(() => ({ status: 400, body: { errorType: "country", errorMessage: "Country is not supported", errorDetails: null } }));
    await expect(api.offers({ currencyFrom: "NGN", currencyTo: "NIM", amountFrom: "1", country: "NG" })).rejects.toThrow("This provider doesn't serve your country.");
  });

  it("refuses an order without an https payment page", async () => {
    const { api } = setup(() => ({ body: { orderId: "o1", redirectUrl: "javascript:alert(1)" } }));
    await expect(
      api.createOrder({ externalOrderId: "e1", externalUserId: "u1", providerCode: "moonpay", currencyFrom: "NGN", currencyTo: "NIM", amountFrom: "1", country: "NG", walletAddress: "x" }),
    ).rejects.toThrow(/Nothing was charged/);
  });

  it("reads an order by our id from a list or a data wrapper", async () => {
    const order = { orderId: "o1", externalOrderId: "e1", status: "completed", payoutAmount: "2100000", transactionHash: "abc" };
    for (const body of [[order], { data: [order] }]) {
      const { api } = setup(() => ({ body }));
      expect(await api.getOrder("e1")).toEqual({ orderId: "o1", externalOrderId: "e1", state: "completed", status: "completed", payoutAmount: "2100000", transactionHash: "abc" });
    }
  });

  it("accepts only webhooks signed by Changelly for our key", () => {
    const { api } = setup(() => ({ body: {} }));
    const body = JSON.stringify({ orderId: "o1", externalOrderId: "e1", status: "pending" });
    const good = sign("sha256", Buffer.from(JSON.stringify({ orderId: "o1" })), theirs.privateKey).toString("base64");
    expect(api.readCallback({ apiKey: "pk_test", signature: good }, body)).toMatchObject({ orderId: "o1", state: "processing" });

    const forged = sign("sha256", Buffer.from(JSON.stringify({ orderId: "o1" })), ours.privateKey).toString("base64");
    expect(api.readCallback({ apiKey: "pk_test", signature: forged }, body)).toBeNull();
    expect(api.readCallback({ apiKey: "someone-else", signature: good }, body)).toBeNull();
    expect(api.readCallback({ apiKey: "pk_test", signature: good }, JSON.stringify({ orderId: "o2", status: "completed" }))).toBeNull();
  });
});

describe("rampState", () => {
  it("maps known words and keeps unknown ones watched", () => {
    expect(rampState("completed")).toBe("completed");
    expect(rampState("refunded")).toBe("failed");
    expect(rampState("hold")).toBe("hold");
    expect(rampState("created")).toBe("awaiting_payment");
    expect(rampState("exchanging")).toBe("processing");
  });
});
