# Without the SDK

You don't have to install `@droplets/save`. The SDK is a convenience: everything it does is plain HTTPS calls to Droplets plus ordinary Nimiq transactions that you sign yourself. This page shows the whole flow with nothing from Droplets in your code.

**What you rely on:**

- `fetch`, or any HTTP client, to call the Droplets API.
- [`@nimiq/core`](https://www.npmjs.com/package/@nimiq/core), Nimiq's own library, or any Nimiq library that can build and sign a basic transaction and an add-stake. Many apps already have it.
- A Nimiq node's JSON-RPC to send the signed transactions, the same one you use for payments today.

The SDK adds a payout log for retries, a fallback when Droplets is slow, and a few safety checks. Without it, you write those yourself: the last section lists them.

## The flow

1. **Ask Droplets how to split the payout.** One `GET`.
2. **Build and sign up to two transactions** from your payout key: a payment to the user's wallet, and an add-stake into their savings.
3. **Send them** to a Nimiq node.
4. **Report the transaction hashes** to Droplets, so the payment shows in the user's history.

If anything about step 1 fails or takes longer than 3 seconds, skip to a normal payment of the full amount. A payout never depends on Droplets.

## 1. Ask for the split

```ts
const API = "https://droplets-api.onrender.com";
const KEY = process.env.DROPLETS_KEY!; // your app key, kept on your server

async function splitFor(address: string, luna: bigint, payoutId: string) {
  try {
    const res = await fetch(
      `${API}/v1/save/split?address=${encodeURIComponent(address)}&luna=${luna}&payoutId=${encodeURIComponent(payoutId)}`,
      { headers: { Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return null; // any problem: pay normally
    const body = (await res.json()) as { wallet: { luna: string }; grow: { luna: string } | null };
    return { walletLuna: BigInt(body.wallet.luna), growLuna: BigInt(body.grow?.luna ?? "0") };
  } catch {
    return null; // Droplets is slow or down: pay normally
  }
}
```

The two amounts always add up to the payout. `growLuna` is `0` for anyone who isn't saving, and for someone who hasn't allowed your app, so you can't tell them apart. If you take save codes, use `?code=SAVE-7KQ2XMP` instead of `address`. Full details are in the [API reference](api-reference.md).

## 2. Build and sign

Using `@nimiq/core`, with the key of one of the addresses you registered:

```ts
import * as Nimiq from "@nimiq/core";

const keyPair = Nimiq.KeyPair.derive(Nimiq.PrivateKey.fromHex(process.env.PAYOUT_KEY!));
const MAINNET = 24;

function buildPayout(user: string, split: { walletLuna: bigint; growLuna: bigint }, height: number) {
  const sender = keyPair.toAddress();
  const to = Nimiq.Address.fromString(user);
  const txs: { kind: "wallet" | "grow"; hex: string; hash: string }[] = [];
  const sign = (tx: any, kind: "wallet" | "grow") => {
    tx.sign(keyPair, undefined);
    txs.push({ kind, hex: tx.toHex(), hash: tx.hash() });
  };
  if (split.walletLuna > 0n) sign(Nimiq.TransactionBuilder.newBasic(sender, to, split.walletLuna, 0n, height, MAINNET), "wallet");
  // The savings part is an add-stake into the user's own stake: the staker is the address you pay.
  if (split.growLuna > 0n) sign(Nimiq.TransactionBuilder.newAddStake(sender, to, split.growLuna, 0n, height, MAINNET), "grow");
  return txs;
}
```

`height` is the current block number, from your node's `getBlockNumber`. A signed transaction is valid for 7,200 blocks (about two hours) from it.

The add-stake is an ordinary transaction to the Nimiq staking contract, `NQ77 0000 0000 0000 0000 0000 0000 0000 0001`, with recipient data `06` followed by the user's 20-byte address. If you use another Nimiq library, build exactly that.

## 3. Send

Post each signed transaction to your node's JSON-RPC:

```ts
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch("https://rpc.nimiqwatch.com", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

const height = await rpc<number>("getBlockNumber", []);
const txs = buildPayout(user, split, height);
for (const tx of txs) await rpc<string>("sendRawTransaction", [tx.hex]);
```

A node answers with the hash even for a payment from an empty wallet, so a successful reply doesn't mean the payment landed. Check `getTransactionByHash` a few minutes later, as you do for any payment.

## 4. Report it

```ts
await fetch(`${API}/v1/save/receipts`, {
  method: "POST",
  headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    address: user,
    payoutId, // the same id you sent in step 1
    walletTx: txs.find((t) => t.kind === "wallet")?.hash,
    growTx: txs.find((t) => t.kind === "grow")?.hash,
  }),
});
```

Droplets checks each hash on the chain: that it came from one of your registered addresses, that it succeeded, and that it went where it should. A hash that isn't in a block yet comes back `"pending"`, so call it again every couple of seconds, up to about ten times. Reporting only affects what the user sees in their history. It never moves money.

If the user stopped allowing your app between steps 1 and 4, the report returns `404`. The payment is already sent, so ignore it.

## What the SDK does that you must do yourself

| SDK feature | What to do without it |
|---|---|
| **3-second limit on Droplets** | `AbortSignal.timeout(3000)` on the split call, and fall back to a normal payment on any failure, as above. |
| **Retry safety** | Save the signed transactions (`hex` and `hash`) in your database *before* sending, keyed by `payoutId`. A retry resends those exact transactions: never sign a new pair for the same payout, or the user is paid twice. |
| **Expiry** | If a payout was signed more than 7,200 blocks ago and never landed, check your wallet history before paying again. |
| **Network check** | Call `getBlockNumber` or your node's network call once and make sure it's mainnet. A node accepts a transaction signed for the wrong network and it never lands. |
| **Refunds** | Don't call the split endpoint for refunds. Pay them in full. |
| **Spend and save** | Quote with `GET /v1/save/spend`, charge `total`, then send the `save` amount as an add-stake after the user pays, and report with `"source": "spend"`. See [Spend and save](spend-and-save.md) and the [API reference](api-reference.md). |

If a user's savings can't take the add-stake by the time you send it (for example it closed), the split in step 1 already says so: `grow` is `null` and the whole amount goes to the wallet. For spend and save, check the user's stake yourself right before sending, and refund the saved part to their wallet if it can't be added.

## Other languages

Nothing here is specific to JavaScript. In any language, you need an HTTP client, a Nimiq library that can sign transactions, and the four steps above. The wire format is in the [API reference](api-reference.md). For example, step 1 is just:

```sh
curl -H "Authorization: Bearer $DROPLETS_KEY" \
  "https://droplets-api.onrender.com/v1/save/split?address=NQ…&luna=200000000&payoutId=bounty-81"
```

## Prefer to read the SDK first?

The SDK is small, and the published package isn't minified: open `node_modules/@droplets/save/dist/payer.js` after installing it and you'll see exactly the steps above in a few hundred lines. You can read it, copy only the parts you want, or skip it entirely.
