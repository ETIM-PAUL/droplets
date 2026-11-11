# Quickstart

A small change to the server code that pays your users. You'll register, install the SDK, and replace one payment call.

!!! tip "Prefer not to install an SDK?"
    You don't need to. [Without the SDK](without-the-sdk.md) shows the same flow using only `fetch` and Nimiq's own library.

## 1. Register

[Register your app](register.md) on the Droplets home page. You get an app key (`rk_save_…`) once. Keep it in an environment variable on your server, for example `DROPLETS_KEY`. It starts working when the Droplets team approves your app.

## 2. Install

```sh
npm install @droplets/save @nimiq/core
```

It needs Node 20 or later, and works in ESM and CommonJS projects.

## 3. Set up the payer

Create it once, when your server starts.

```ts
import { createNimiqRpc, createSaveApi } from "@droplets/save";
import { createSavePayer, memoryPayoutLog } from "@droplets/save/payer";
import * as Nimiq from "@nimiq/core";

const payer = createSavePayer({
  api: createSaveApi({ apiUrl: "https://droplets-api.onrender.com", apiKey: process.env.DROPLETS_KEY! }),
  rpc: createNimiqRpc({ url: "https://rpc.nimiqwatch.com" }), // a Nimiq mainnet node
  nimiq: Nimiq,
  keyPair: Nimiq.KeyPair.derive(Nimiq.PrivateKey.fromHex(process.env.PAYOUT_KEY!)), // one of the addresses you registered
  network: "main",
  log: memoryPayoutLog(), // fine to try it; use a database in production (see "Retries")
});

await payer.checkNetwork(); // fails now if the node is on another network
```

`PAYOUT_KEY` is the private key of an address you registered. It never leaves your server.

## 4. Pay users through it

Wherever you send a reward today, call `pay()` with the same address you pay now:

```ts
const result = await payer.pay({
  to: userAddress,          // the address you already pay (from Nimiq Pay's listAccounts())
  luna: 200_000_000n,       // 2,000 NIM. Amounts are luna: 100,000 luna = 1 NIM
  payoutId: "bounty-81",    // unique per payout; makes retries safe
  memo: "Bounty #81",       // optional
});
// result.walletLuna and result.growLuna say how it was split. growLuna is 0n for people not saving.
```

That's it. If the user allowed your app in Droplets, `result` shows two transactions: the saved share added to their stake, and the rest paid to their wallet. For everyone else it sends one normal payment, as before.

## 5. Check it

Ask a user with Droplets to allow your app (under **Profile > Saving rules**), then pay them a small amount. You'll see the split in `result`, and the payment shows in their **Activity** under your app's name.

## Next

- [Paying users](paying-users.md): save codes, refunds and what `pay()` does in each case.
- [Spend and save](spend-and-save.md): if users also pay you.
- [Retries, receipts and going live](going-live.md): before you use real money.
