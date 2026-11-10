# Retries, receipts and going live

## Retries

`payoutId` makes retries safe. The payer writes the signed transactions to its **payout log** before sending them. A retry with the same `payoutId` resends those exact transactions, so a user is never paid twice.

`memoryPayoutLog()` is the default and only lasts as long as your process. **In production, keep the log in your database** by implementing two functions:

```ts
import type { PayoutLog } from "@droplets/save/payer";

const log: PayoutLog = {
  get: async (payoutId) => (await db.payouts.find(payoutId)) ?? undefined,
  put: async (record) => void (await db.payouts.save(record)),
};
```

Store `record` as JSON (it includes `bigint` values: store them as strings and convert back, or use your database's big-number type).

A signed transaction is valid for 7,200 blocks, about 2 hours. If a payout was signed but never confirmed, and that window has passed, `pay()` throws instead of signing new transactions. Check your wallet history before paying again.

## "Sent" isn't "landed"

When `pay()` returns, the node has taken the transactions. That doesn't mean they'll land: a public node answers with a hash even for a payment from an empty wallet. Check `rpc.transaction(walletTx)` a few minutes later. If it's still not there, top up your payout wallet and call `pay()` again with the same `payoutId` to resend.

## Receipts

`pay()` and `saveFromSpend()` report the transaction hashes to Droplets, so each payment shows in the user's savings history. Droplets checks every one on-chain:

- the sender is one of your registered addresses;
- it succeeded;
- the wallet payment went to the user's address;
- the add-stake went to the staking contract and names the user's address.

A transaction that isn't in a block yet comes back `pending`, and the payer reports again every 2 seconds, up to 10 times.

## The first payment after a quiet time

The free server Droplets runs on sleeps when it's idle, and waking it can take up to a minute. Because the SDK gives up after 3 seconds, the first payment after a quiet time may go out as one normal payment instead of a split. To avoid it, warm the server up just before a batch of payouts:

```ts
await fetch("https://droplets-api.onrender.com/health").catch(() => undefined);
```

## Checklist before real money

1. Your app is **approved** (a request with your key returns 200, not 403).
2. `payer.checkNetwork()` passes: your node and `network` are both mainnet.
3. Your payout wallet holds enough NIM for payouts and fees, and its address is one you registered.
4. The payout log is in a database, not memory.
5. You tested with a small payment to a user who allowed your app, and it shows in their Activity.
6. Refunds use `into: "wallet"`.
7. Your key is only in your server's environment: never in a Mini App, a repository or a log.

## If something fails

| What you see | Why |
|---|---|
| `401 Missing or unknown app key` | The key is wrong, or was replaced. |
| `403 … waiting for review` | The app isn't approved yet. |
| `403 … wasn't sent from one of this app's payout addresses` | You paid from an address you didn't register. |
| `429` | Too many requests. Slow down. |
| `502` | Droplets couldn't reach the Nimiq network. Try again in a minute. |

A payment is never blocked by any of these: the SDK falls back to a normal payment.
