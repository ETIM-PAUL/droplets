# Spend and save

If users also **pay you**, they can save a little on every purchase. A user who chose, say, 5% pays your price plus 5%, and your app puts the extra into their savings.

This is optional. You only need it if your app takes payments.

## 1. Quote

Before you ask the user to pay, ask Droplets what to charge:

```ts
import { createSaveApi } from "@droplets/save";

const api = createSaveApi({ apiUrl: "https://droplets-api.onrender.com", apiKey: process.env.DROPLETS_KEY! });

const quote = await api.spend(userAddress, 10_000_000n).catch(() => null); // a 100 NIM price
const charge = quote?.totalLuna ?? 10_000_000n; // 105 NIM for a user saving 5%; 100 NIM for everyone else
```

Show the user both parts, for example "100 NIM + 5 NIM to your savings". If the quote fails, charge the price alone: a purchase never waits on Droplets.

## 2. Take the payment

Request `charge` with Nimiq Pay as usual.

## 3. Save the extra

Once the payment has arrived, add the saved part to the user's stake:

```ts
if (quote && quote.saveLuna > 0n) {
  await payer.saveFromSpend({ to: userAddress, luna: quote.saveLuna, payoutId: `order-${orderId}-save` });
}
```

`saveFromSpend()` needs `rpc.staker` and `rpc.validator`, which the `createNimiqRpc` from `@droplets/save` has.

## Good to know

- **The saved part is the user's money.** If their stake can't take it by the time you send it (it closed, or its validator left), `saveFromSpend()` sends it back to their wallet instead. Never keep it.
- **One quote per purchase.** Keep the quote with the order, so a retry saves the same amount. `payoutId` makes `saveFromSpend()` retry-safe, like `pay()`.
- **Only for users who allowed your app.** For anyone else, `saveLuna` is `0n` and `totalLuna` equals your price.
- **The user always sees the full amount** in Nimiq Pay before approving, so charge exactly what you quoted.
