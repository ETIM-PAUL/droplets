# How it works

Droplets lets apps that pay people NIM, or take payments in NIM, save for their users without holding any of their money.

## Two things your app can do

**Pay a user.** Before you send a payout, ask Droplets how to split it. If the user allowed your app (or gave you their save code), the payout becomes two transactions from your payout account: the rest to their wallet, and their saved share added to their own stake. For everyone else it's one normal payment, exactly as today.

**Take a payment (spend and save).** Ask Droplets what to charge. A user who saves when they pay is charged the price plus their share. After they pay, your app adds that share to their stake.

## What stays the same

- **You pay the user directly.** Droplets never holds the money. Its API only tells you how to split a payment and records what you sent.
- **You keep your payout key.** The SDK signs on your server with your key.
- **You don't need the user's save code.** Most Mini Apps get the user's address from Nimiq Pay and pay it. Keep doing that: if the user allowed your app, the address is enough.
- **Payments never wait on Droplets.** If Droplets doesn't answer within 3 seconds, the SDK sends one normal payment.
- **You can't learn who uses Droplets.** A user who didn't allow your app gets the same answer as someone who doesn't use Droplets.

## What you need

1. A server that sends your payouts, with a Nimiq payout key. Droplets can't be used from the Mini App's front end, because it signs with your key.
2. **An app key and registered payout addresses.** [Register your app](register.md); the Droplets team approves it.
3. The SDK, [`@droplets/save`](quickstart.md), or the [HTTP API](api-reference.md) if you don't use Node.

## What users see

Users pick your app by name in their saving rules, so choose a name people will recognise. Your payouts show in their Activity under that name, split into the part saved and the part paid to their wallet.
