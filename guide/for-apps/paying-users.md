# Paying users

`payer.pay()` is the one call for paying people. What it does depends on who you pay.

## What `pay()` does

| You pay | What happens |
|---|---|
| **A user's address who allowed your app** | Droplets splits the payout by the user's rule: their share is added to their own stake and the rest goes to their wallet. Two transactions from your payout account. |
| **Any other address** | One normal payment. Droplets answers the same for "doesn't use Droplets" as for "didn't allow your app". |
| **A save code** (`SAVE-7KQ2XMP`) | Split by the code owner's rule, even if they haven't picked your app. A code that isn't active is refused. |
| **Droplets doesn't answer in 3 seconds** | One normal payment. Your payouts never wait on Droplets. |

Droplets rounds the saved share down, and the user's wallet gets the odd luna.

## Addresses and codes

**Most apps just pay an address.** Mini Apps get the user's address from Nimiq Pay (`listAccounts()[0]`) and pay it. Keep doing that: a user who picked your app is split automatically, and nobody else is affected.

**If you ask people to type or paste an address,** also accept a save code there. `parseSaveCode` tells them apart and catches typos with the code's check character:

```ts
import { parseSaveCode } from "@droplets/save";

const code = parseSaveCode(input); // { ok: true, value: "7KQ2XMP" } or { ok: false, error }
```

Codes ignore case, spaces and dashes, and read `O` as `0` and `I` or `L` as `1`.

## Not a reward? Skip the split

For anything that isn't a reward, such as refunding an entry fee, pay with `into: "wallet"`:

```ts
await payer.pay({ to: userAddress, luna: fee, payoutId: `refund-${orderId}`, into: "wallet" });
```

That sends one normal payment without asking Droplets. There's also `into: "grow"`, which adds everything to the address's stake without asking, but it only works if that address already stakes.

## When nothing goes to savings

`pay()` sends a single normal payment and `result.reason` says why:

| `reason` | Meaning |
|---|---|
| `no-stake` | The user has closed their savings since choosing their rule. |
| `validator-gone` | The validator they staked with has closed. |
| `below-minimum` | Their stake would end up under Nimiq's 100 NIM minimum. |
| `null` | Nothing was asked of Droplets, or it was split as normal. |

Your payout never fails because of savings.

## Don't cache the split

Users can change their rule, or stop allowing your app, at any time. Look the split up on every payment, which `pay()` does for you.
