# HTTP API reference

For apps that don't use Node. Everything the SDK does, you can do with these calls.

**Base address:** `https://droplets-api.onrender.com`

**Authentication:** send `Authorization: Bearer rk_save_…` (your app key) on the calls below marked *app key*.

**Amounts** are in luna, as strings: 100,000 luna is 1 NIM.

**Errors** are JSON: `{ "error": { "message": "…" } }`.

## Split a payout

`GET /v1/save/split` · *app key*

Query: `address=NQ…` (the address you pay) **or** `code=SAVE-7KQ2XMP`, and `luna=200000000`. Optional: `payoutId=bounty-81`. Send it: Droplets keeps the split, so when a payment goes to the user's wallet they can ask why.

```json
{ "code": "SAVE-7KQ2XMP", "address": "NQ…", "savePercent": 30,
  "wallet": { "luna": "140000000" }, "grow": { "luna": "60000000", "staker": "NQ…" }, "reason": null }
```

`grow` is `null` when nothing goes to savings. For an address, `code` is `null`, and a user who hasn't allowed your app gets `"savePercent": 0` and `"grow": null`. For a code, a `404` means it isn't active: pay the user's address instead.

## Quote spend and save

`GET /v1/save/spend?address=NQ…&luna=10000000` · *app key*

```json
{ "address": "NQ…", "spendPercent": 5, "price": "10000000", "save": "500000", "total": "10500000", "staker": "NQ…", "reason": null }
```

Charge `total`. `save` is `"0"` when nothing goes on top.

## Report what you sent

`POST /v1/save/receipts` · *app key*

```json
{ "address": "NQ…", "payoutId": "bounty-81", "walletTx": "<64 hex>", "growTx": "<64 hex>", "source": "payout" }
```

Send `code` instead of `address` if you paid a code. `source` is `"payout"` (default) or `"spend"` for the part saved when a user paid you. Send either or both hashes. The reply is `"recorded"` or `"pending"` for each. A `4xx` says what didn't check out.

## Building the transactions yourself

- **The wallet part** is a basic transaction to `address`.
- **The savings part** is an add-stake: recipient `NQ77 0000 0000 0000 0000 0000 0000 0000 0001` (the staking contract), with recipient data `06` followed by the 20 bytes of `staker`. With `@nimiq/core`: `TransactionBuilder.newAddStake(sender, stakerAddress, value, fee, validityStartHeight, networkId)`.
- **Network ID** 24 is mainnet.

## Public calls

These need no key.

| Call | Returns |
|---|---|
| `GET /v1/save/apps` | The approved apps: `{ "apps": [{ "id", "name", "url" }] }` |
| `POST /v1/save/apps/register` | Signs an app up: body `{ "name", "url"?, "contact", "payoutAddresses": [] }`, reply `{ "id", "name", "apiKey", "status": "pending" }`. The key works once the app is approved. |
| `GET /health` | `{ "ok": true }`. Use it to wake the server. |

## Status codes

| Code | Meaning |
|---|---|
| 400 | Something in the request isn't valid. The message says what. |
| 401 | Missing or unknown app key. |
| 403 | The app is waiting for review, or a transaction wasn't sent from a registered address. |
| 404 | No such code, or the address hasn't allowed your app. |
| 429 | Too many requests. |
| 502 | Droplets couldn't reach the Nimiq network. Try again in a minute. |
