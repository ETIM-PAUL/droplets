# Saving with Droplets: for apps that pay people, and apps people pay

For Mini Apps that pay people NIM (games, bounties, quizzes, cashback), and apps that take payments (shops, entry fees).

Droplets users set a rule, such as "save 30% of what apps pay me, and 5% more when I pay an app". You apply it in two ways:
- **When you pay a user,** pay the address you already pay. If its owner allowed your app in Droplets, the payment splits by their rule. Everyone else gets one normal payment, as now. Users can also give you a save code (`SAVE-7KQ2XMP`) where you ask for an address.
- **When a user pays you,** ask Droplets what to charge. For a user who allowed your app, a share goes on top, and you put that share into their savings once they've paid. See [Spend and save](#spend-and-save).

When you pay a saver, you send two transactions from your payout account:
- a normal payment of the rest to the user's address;
- an add-stake of the saved share into their own stake, called **Grow** in Droplets.

You pay the user directly. Droplets never holds the money; its API only tells you how to split each payment and records what you sent.

## Install

```sh
npm install @droplets/save
```

It runs on your server, never in a Mini App's front end: it signs with your payout key. It needs Node 20 or later and `@nimiq/core` (you pass it in as `nimiq`).

## 1. Get an app key

Register your app on the Droplets landing page (**For apps > Register your app**) with its name and the Nimiq addresses you pay from. You get an `rk_save_…` key once, and it starts working when the Droplets team approves the app. Keep it on your server.

Droplets only accepts receipts for transactions sent from the addresses you registered.

## 2. Pay the address you already pay

Most Mini Apps get the user's address from Nimiq Pay (`listAccounts()[0]`) and pay it. Keep doing that, and pay through the SDK (step 3). Users who allowed your app in Droplets get their split; nobody else is affected.

Droplets answers the same for "doesn't save with Droplets" as for "didn't allow your app", so you can't find out who uses Droplets.

If you ask people to type or paste an address, also accept a save code there. `parseSaveCode` tells them apart and catches typos with the code's check character:

```ts
import { parseSaveCode } from "@droplets/save";

const code = parseSaveCode(input); // { ok: true, value: "7KQ2XMP" } or { ok: false, error }
```

Codes ignore case, spaces and dashes, and read `O` as `0` and `I`/`L` as `1`.

## 3. Pay

```ts
import { createNimiqRpc, createSaveApi } from "@droplets/save";
import { createSavePayer } from "@droplets/save/payer";
import * as Nimiq from "@nimiq/core";

const payer = createSavePayer({
  api: createSaveApi({ apiUrl: "https://droplets-api.onrender.com", apiKey: process.env.DROPLETS_KEY! }),
  rpc: createNimiqRpc({ url: "https://rpc.nimiqwatch.com" }), // testnet: https://rpc.testnet.nimiqwatch.com
  nimiq: Nimiq,
  keyPair: yourPayoutKeyPair, // a @nimiq/core KeyPair for one of your registered payout addresses
  network: "main", // or "test"
  log: yourPayoutLog, // see "Retries" below
});

const result = await payer.pay({ to: "SAVE-7KQ2XMP", luna: 200_000_000n, payoutId: "bounty-81", memo: "Bounty #81" });
// { walletTx, growTx, walletLuna: 140_000_000n, growLuna: 60_000_000n, reason: null, ... }
```

- **Amounts are luna** (100,000 luna is 1 NIM). The saved share is rounded down, and the user's wallet gets the odd luna.
- **An address asks Droplets first.** It's split if its owner allowed your app; otherwise it's one normal payment. If Droplets doesn't answer within 3 seconds, it's one normal payment too, so your payouts never wait on Droplets.
- **Refunds: `into: "wallet"`.** It sends one normal payment without asking Droplets. Use it for anything that isn't a reward, such as giving back an entry fee.
- **`into: "grow"`** sends it all as an add-stake into that address's own stake, without asking Droplets. That only works if the address already stakes, so check first.
- **The memo** is optional, up to 64 bytes, and goes on the wallet payment only.
- **`network` must match the node.** A node takes a payment signed for the other network, answers with its hash, and never includes it. So `pay()` checks once which chain the node follows, and throws without signing anything if it's the wrong one. Call `await payer.checkNetwork()` at startup to find out sooner.

### When nothing goes to savings

`pay()` sends a single normal payment, and `reason` says why:

| `reason` | Meaning |
|---|---|
| `no-stake` | The user has closed Grow since getting their code. Codes are only given out once Grow is open. |
| `validator-gone` | The validator they staked with has been deleted. |
| `below-minimum` | Their stake would end up under Nimiq's 100 NIM minimum. |

Your payout never fails because of savings.

## Spend and save

When a user pays you, ask what to charge before you request the payment:

```ts
const api = createSaveApi({ apiUrl: "https://droplets-api.onrender.com", apiKey: process.env.DROPLETS_KEY! });
const quote = await api.spend(userAddress, 10_000_000n).catch(() => null); // a 100 NIM price
const charge = quote?.totalLuna ?? 10_000_000n; // 105 NIM for a user saving 5% when they pay; 100 NIM for everyone else
```

Show the user both parts, for example "100 NIM + 5 NIM to your savings". Request `charge` with Nimiq Pay as usual. Once the payment has arrived, put the saved part into their stake:

```ts
if (quote && quote.saveLuna > 0n) {
  await payer.saveFromSpend({ to: userAddress, luna: quote.saveLuna, payoutId: `order-${orderId}-save` });
}
```

- **The saved part is the user's money.** If their stake can't take it by the time you send it (it closed, or its validator left), `saveFromSpend()` sends it back to their wallet instead. Never keep it.
- **One quote per purchase.** Keep the quote with the order, so a retry saves the same amount. `payoutId` makes `saveFromSpend()` retry-safe, like `pay()`.
- **If the quote fails,** charge the price alone. A purchase never waits on Droplets.
- `saveFromSpend()` reads the user's stake from your node, so pass an `rpc` from `createNimiqRpc` (exported by `@droplets/save`), which can.

## Retries

`payoutId` makes retries safe. The payer writes the signed transactions to its `PayoutLog` before sending them. A retry with the same `payoutId` resends those exact transactions, so the user is never paid twice.

`memoryPayoutLog()` is the default, which only lasts as long as your process. In production, store records in your database by implementing `get` and `put`.

A signed transaction is valid for 7,200 blocks, about 2 hours. If a payout was signed but never confirmed, and that window has passed, `pay()` throws instead of signing new transactions. Check your wallet history before paying again.

When `pay()` returns, the node has taken the transactions. That doesn't mean they'll land: the public node answers with a hash even for a payment from an empty wallet. Check `rpc.transaction(walletTx)` a few minutes later. If it's still not there, top up your payout wallet and call `pay()` again with the same `payoutId` to resend.

## Receipts

`pay()` and `saveFromSpend()` report the transaction hashes to Droplets, so the payment shows in the user's savings history. Droplets checks each one on-chain:
- the sender is one of your registered addresses;
- it succeeded;
- the wallet payment went to the user's address;
- the add-stake went to the staking contract and names the user's address.

A transaction that isn't in a block yet comes back `pending`. The payer reports again every 2 seconds, up to 10 times.

## The HTTP API

If you don't use TypeScript, call the API directly with `Authorization: Bearer rk_save_…`.

**`GET /v1/save/split?code=SAVE-7KQ2XMP&luna=200000000&payoutId=bounty-81`**, or **`?address=NQ…&luna=…`** for the address you pay.

`payoutId` is optional but worth sending: Droplets keeps the split, so when a payment goes to the user's wallet they can ask Droplets why ("Grow wasn't open"). The SDK sends it for you.

```json
{ "code": "SAVE-7KQ2XMP", "address": "NQ…", "savePercent": 30,
  "wallet": { "luna": "140000000" }, "grow": { "luna": "60000000", "staker": "NQ…" }, "reason": null }
```

`grow` is `null` when nothing goes to savings. For an address, `code` is `null`, and anyone who hasn't allowed your app gets `"savePercent": 0`, `"grow": null`. For a code, a `404` means the code isn't active: pay the user's address instead.

**`GET /v1/save/spend?address=NQ…&luna=10000000`** returns `{ "address", "spendPercent", "price", "save", "total", "staker", "reason" }`, luna as strings. Charge `total`; `save` is `"0"` when nothing goes on top.

**Building the transactions yourself:**
- The wallet part is a basic transaction to `address`.
- The Grow part is an add-stake: recipient `NQ77 0000 0000 0000 0000 0000 0000 0000 0001` (the staking contract), with recipient data `06` followed by the 20 bytes of `staker`. With `@nimiq/core` that's `TransactionBuilder.newAddStake(sender, stakerAddress, value, fee, validityStartHeight, networkId)`.
- Network ID 24 is mainnet; 5 is testnet.

**`POST /v1/save/receipts`** with `{ "code" or "address", "payoutId", "walletTx"?, "growTx"?, "source"? }` returns `"recorded"` or `"pending"` for each hash. Send `"source": "spend"` for the part saved when a user paid you. A `4xx` says what didn't check out.

## Notes

- The SDK is the npm package `@droplets/save`, for Node 20 or later, in both ESM and CommonJS. Its source is `packages/save` in the Droplets repo.
- Users can change their rule, or stop allowing your app, at any time. Look the split up on every payment rather than caching it.
- Never send your payout key anywhere. The SDK signs on your server and only sends Droplets the transaction hashes.
