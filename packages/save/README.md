# Paying rewards with save codes

For Mini Apps that pay people NIM: games, bounties, quizzes, cashback.

A save code (`SAVE-7KQ2XMP`) stands for one Nimiq Pay user and their rule, such as "save 30%". When you pay that code, you send two transactions from your payout account:
- a normal payment of the rest to the user's address;
- an add-stake of the saved share into their own stake, called **Grow** in Errand.

You pay the user directly. Errand never holds the money; its API only tells you how to split each payment and records what you sent.

## 1. Get an app key

Ask the Errand team to register your app with its name and the Nimiq addresses you pay from. You get an `rk_save_…` key once. Keep it on your server.

Errand only accepts receipts for transactions sent from the addresses you registered.

## 2. Accept a code where you'd ask for an address

Let people paste a save code or a Nimiq address into the same field. `parseSaveCode` tells them apart and catches typos with the code's check character:

```ts
import { parseSaveCode } from "@railkit/save";

const code = parseSaveCode(input); // { ok: true, value: "7KQ2XMP" } or { ok: false, error }
```

Codes ignore case, spaces and dashes, and read `O` as `0` and `I`/`L` as `1`.

## 3. Pay

```ts
import { createNimiqRpc } from "@railkit/core";
import { createSaveApi } from "@railkit/save";
import { createSavePayer } from "@railkit/save/payer";
import * as Nimiq from "@nimiq/core";

const payer = createSavePayer({
  api: createSaveApi({ apiUrl: "https://<errand api>", apiKey: process.env.ERRAND_SAVE_KEY! }),
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
- **A plain Nimiq address works too.** `to` can be an address, which sends a single normal payment and doesn't contact Errand at all.
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

## Retries

`payoutId` makes retries safe. The payer writes the signed transactions to its `PayoutLog` before sending them. A retry with the same `payoutId` resends those exact transactions, so the user is never paid twice.

`memoryPayoutLog()` is the default, which only lasts as long as your process. In production, store records in your database by implementing `get` and `put`.

A signed transaction is valid for 7,200 blocks, about 2 hours. If a payout was signed but never confirmed, and that window has passed, `pay()` throws instead of signing new transactions. Check your wallet history before paying again.

When `pay()` returns, the node has taken the transactions. That doesn't mean they'll land: the public node answers with a hash even for a payment from an empty wallet. Check `rpc.transaction(walletTx)` a few minutes later. If it's still not there, top up your payout wallet and call `pay()` again with the same `payoutId` to resend.

## Receipts

`pay()` reports both transaction hashes to Errand, so the payment shows in the user's savings history as "Paid in with your code". Errand checks each one on-chain:
- the sender is one of your registered addresses;
- it succeeded;
- the wallet payment went to the user's address;
- the add-stake went to the staking contract and names the user's address.

A transaction that isn't in a block yet comes back `pending`. The payer reports again every 2 seconds, up to 10 times.

## The HTTP API

If you don't use TypeScript, call the API directly with `Authorization: Bearer rk_save_…`.

**`GET /v1/save/split?code=SAVE-7KQ2XMP&luna=200000000&payoutId=bounty-81`**

`payoutId` is optional but worth sending: Errand keeps the split, so when a payment goes to the user's wallet they can ask Errand why ("Grow wasn't open"). The SDK sends it for you.

```json
{ "code": "SAVE-7KQ2XMP", "address": "NQ…", "savePercent": 30,
  "wallet": { "luna": "140000000" }, "grow": { "luna": "60000000", "staker": "NQ…" }, "reason": null }
```

`grow` is `null` when nothing goes to savings. A `404` means the code isn't active: pay the user's address instead.

**Building the transactions yourself:**
- The wallet part is a basic transaction to `address`.
- The Grow part is an add-stake: recipient `NQ77 0000 0000 0000 0000 0000 0000 0000 0001` (the staking contract), with recipient data `06` followed by the 20 bytes of `staker`. With `@nimiq/core` that's `TransactionBuilder.newAddStake(sender, stakerAddress, value, fee, validityStartHeight, networkId)`.
- Network ID 24 is mainnet; 5 is testnet.

**`POST /v1/save/receipts`** with `{ "code", "payoutId", "walletTx"?, "growTx"? }` returns `"recorded"` or `"pending"` for each hash. A `4xx` says what didn't check out.

## Notes

- The SDK lives in the RailKit repo (`packages/save`) and isn't on npm yet.
- Users can change their share or turn their code off at any time. Look the split up on every payment rather than caching it.
- Never send your payout key anywhere. The SDK signs on your server and only sends Errand the transaction hashes.
