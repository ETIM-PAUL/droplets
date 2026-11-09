# Errand Save — Product Plan

Working name. Written 4 November 2026. Replaces the earlier save-codes plan.

Updated 8 November: Steady and Boost, a two-sided pool, are dropped. Boost was a bet on NIM's price rather than saving, and Errand would have held the pool's NIM.

## What it is

One savings account inside Nimiq Pay, with four ways in.

**Ways in**
1. **Save code, or an app the user allows.** Other Mini Apps pay rewards, bounties and cashback using the user's code. Apps the user allows in Errand don't need the code: they pay the address they already have, and Errand recognises it. Each payment splits by the user's rule, for example 30% to savings and 70% to the wallet.
2. **Bitcoin Lightning.** The same code is also a Lightning address. Anyone can send sats from any Lightning wallet, and they arrive as NIM savings. Users with a supported wallet can also save automatically every week.
3. **Direct.** The user moves NIM from their own wallet into savings.
4. **Spend and save.** When the user pays an app they allow, a share such as 5% goes on top of the price, and the app puts it into Grow.

**Where it's kept:** in **Grow**, NIM staked in the user's own account. It earns staking rewards and follows NIM's price, and only the user can move it. Withdrawing takes 12 to 24 hours.

**Example.** Amaka sets "save 30%".
- An arcade game pays her 2,000 NIM with her code. 600 NIM goes into Grow and 1,400 NIM to her wallet.
- Her uncle in London sends 20,000 sats to `7kq2xmp@<our domain>` from his Lightning wallet. They arrive as NIM and follow the same rule.

## One code, two forms

- **Save code:** `SAVE-7KQ2XMP`, entered in any Mini App that pays NIM.
- **Lightning address:** `7kq2xmp@<our domain>`, used from any Lightning wallet.

Both point to the same user and the same rule: how much of each payment to save, from 0 to 100%.

The code is 6 random characters plus 1 check character, using Crockford base32 (`0-9`, `A-Z` without `I L O U`) with a Luhn mod 32 check character. That allows about 1.07 billion codes. Input ignores case, spaces and dashes, and reads `O` as `0` and `I`/`L` as `1`. There is one active code per address; users can revoke it and get a new one. The code isn't a secret: a lookup reveals only the address, the rule and whether Grow is open. Lookups need an app key and are rate-limited.

## Routing: where each payment goes

Every payment, whether NIM from an app or sats from Lightning, is split by the same function:

1. **Savings part:** `floor(amount × savePercent / 100)` in luna, into Grow. The wallet gets the rest.
2. **Fallbacks:**
   - If **Grow can't take it**, the whole payment goes to the wallet. That happens when Grow isn't open (no stake, or the user's validator was deleted) or would stay under 100 NIM. Codes are only given out once Grow is open, so this only happens if Grow closes later.
   - If a part comes out at 0, it isn't sent.

| Destination | From an app (save code) | From Lightning |
|---|---|---|
| Wallet | Normal payment to the user's address | Our swap account pays the user's address |
| Grow | The app sends an add-stake into the user's stake | Our swap account sends an add-stake into the user's stake |

Add-stake needs no signature from the user, so apps (and our swap account) can pay straight into a user's Grow savings. Staking pools do this daily on mainnet.

### Apps the user allows (added 9 November 2026)

Most Mini Apps never ask for an address: they read it from Nimiq Pay and pay it. So the signed rule also names the apps that may recognise the user's address. Such an app asks for the split by address (`GET /v1/save/split?address=…`). Errand answers only for users who allowed that app, and gives everyone else "pay it all to the wallet", which is also what a non-user gets. So apps can't probe who saves with Errand. The SDK asks on every payout to an address, gives up after 3 seconds, and then pays normally. Refunds use `into: "wallet"` and never ask.

### Spend and save (added 9 November 2026)

The rule also carries a share to save when paying, from 0 to 100% (the screen offers 0, 5, 10 and 20%). When a user pays an app they allow, the app asks what to charge (`GET /v1/save/spend`): the price plus `floor(price × spendPercent / 100)`, or the price alone if Grow can't take it. The user approves the total in Nimiq Pay, once. Then the app adds the saved part to the user's stake with `saveFromSpend()`, which sends it back to the wallet instead if the stake can no longer take it. Errand records it as "Saved when you paid …".

Errand still never sends money: the paying app collects the saved part with the purchase and passes it on, the same trust the user already gives that app for the purchase. Payments made outside apps that save with Errand, such as Nimiq Pay's own transfers, can't save on top: no app or Errand can move the user's NIM after it's sent.

## Grow: staked NIM

Grow works the same as in the save-codes plan:

- **Opening Grow.** If the user already stakes with any validator, that stake is their Grow savings. Otherwise they pick a validator and stake at least 100 NIM with Nimiq Pay's `sendNewStakerTransaction`.
- **Adding.** Once the stake exists, any amount can be added, as long as active plus inactive stays at least 100 NIM.
- **Withdrawing.**
  1. Move stake to inactive (`sendSetActiveStakeTransaction`).
  2. Wait 12 to 24 hours. The lock-up starts at the next election block and lasts one epoch; if the validator is jailed, it can take up to 4 days.
  3. Retire it (`sendRetireStakeTransaction`), then remove it (`sendRemoveStakeTransaction`).

  What's left must be 0 or at least 100 NIM.
- **Rewards** come from the user's chosen validator pool, under that pool's terms.

## Weekly draw

A prize-linked savings draw. Nobody can lose anything: savings stay in each person's own stake, and only the prize is chance.

- **Rules.** Join with a signed message. Keep at least 1,000 NIM in Grow on 5 of the 7 days (Monday to Sunday, West Africa Time) to be in Sunday's draw at 23:59. The winner gets 1,000 NIM, paid as an add-stake into their Grow.
- **Bigger savers.** 1 ticket at the minimum and one more for each 10 times as much, up to 4, so the biggest savers can't win every week. Tickets follow the amount kept on 5 days, so a one-day top-up doesn't count.
- **Kept days come from the chain.** Only the owner can lower their active stake, with a set-active-stake transaction that records the new amount. Others can only add. So Errand's reconstruction of each day's lowest stake errs low, never high, even if the API was asleep.
- **The winner** is the ticket at (first block hash after the draw time) modulo the total, with entries in address order. Anyone can redo it from the stored entries.
- **One entry per phone,** using Nimiq Pay's device identifier. Someone with several phones can still enter several accounts.
- **Funding.** At first, Errand's launch budget (1,000 NIM is a few cents at today's price). Later: sponsors, or the fee of an Errand staking pool. Prize-linked savings raised savers' total savings by about 38% in South Africa (Cole, Iverson & Tufano).

## Lightning: Bitcoin in, NIM savings out

### One-off sends

The Lightning address uses LNURL-pay.
1. The payer's wallet asks for an invoice.
2. Our server creates a Lightning-to-NIM swap and returns the invoice. Ideally that's Fastspot's invoice, so the sats go straight to Fastspot.
3. When the swap settles, the NIM reaches our swap account, which routes it by the user's rule.

The payer can add a comment, such as "From Uncle Tunde", which shows in the user's history.

### Weekly auto-save

Users connect a wallet that supports Nostr Wallet Connect (NWC) budgets. Alby Hub is confirmed: our app opens its `/apps/new` link with:
- `max_amount` (in millisats per period);
- `budget_renewal=weekly`;
- `request_methods=pay_invoice`;
- `return_to`.

The user approves once. Each week, a job creates a swap invoice and asks the wallet to pay it through NWC. If the wallet replies `QUOTA_EXCEEDED`, the budget is used up. If the wallet is offline, retry later. Only always-online wallets work reliably: Alby Hub, or custodial web wallets. Phone wallets may only answer while open.

### Where the NIM comes from

- **First choice: Fastspot**, Nimiq Pay's own swap partner. Its client library models Lightning on either side of a swap. Whether it offers Lightning to NIM to an outside service, and on what terms, hasn't been confirmed; that's the first open question below.
- **Fallback:** exchange APIs or our own NIM inventory. Both mean holding users' funds and running an exchange service, with the licensing that comes with it.

## System design

### API (`apps/api`)

- **Codes and rules:** create, update and revoke a code with a signed message, the same as the earlier plan. The signed text includes the rule: "Save: 30%".
- **`GET /v1/save/split?code=&luna=`:** returns the wallet and Grow parts and, when Grow can't take its part, why. It applies the fallbacks.
- **Receipts:** apps report transaction hashes, and we verify each on-chain. Add-stakes paid by others don't appear in a staker's own history, so receipts are how the "saved, by source" view works.
- **Lightning service:**
  - the LNURL-pay endpoints (`/.well-known/lnurlp/<code>`);
  - the swap orchestrator;
  - the NWC client for weekly auto-save, with connection secrets encrypted at rest.

**Storage.** Postgres (`DATABASE_URL`, following `PgOpsStore`):
- `save_codes`, `save_apps`, `save_receipts`, `save_nonces`;
- `ln_swaps`, `nwc_connections`.

### SDK for paying apps (`@railkit/save`)

`payer.pay({ code, luna, payoutId })` looks up the split and sends up to two transactions:
- a basic payment to the wallet;
- an add-stake for Grow.

It then reports the receipts. Retrying with the same `payoutId` reuses the transactions already sent. The app's key never leaves its server.

### Keys

- **Swap account.** It only receives NIM from swaps and forwards it within seconds. Alert if its balance doesn't return to near zero.

## Screens in Errand

- **Savings home:**
  - Grow balance in NIM;
  - money in, by source (apps, Lightning, direct);
  - the code and Lightning address card;
  - "Change rule".
- **Set up:**
  1. Open Grow with at least 100 NIM, unless the user already stakes. No code is given out before Grow is open.
  2. Choose how much to save, with an example.
  3. Sign.
  4. Get the code and Lightning address.
- **Share:** the code, the Lightning address, a QR code for each, and copy and share buttons.
- **Weekly auto-save:** connect a wallet (Alby Hub), pick an amount, and see the connection's status.
- **Withdraw:** the Grow steps, with the timing shown.

## Rollout

| Phase | Depends on | What ships |
|---|---|---|
| 1. Save codes + Grow + the weekly draw | Nothing external | Codes, rules, routing, receipts, the SDK, the draw and screens; testnet first, then a mainnet pilot with three apps that already pay NIM. Competition entries are open source, so we can open the integration pull requests ourselves. |
| 2. Lightning | Fastspot's answer | Lightning addresses for one-off sends, then weekly auto-save through NWC. This phase moves earlier if Fastspot agrees quickly. |

Ask Fastspot now, in parallel with Phase 1.

## What the team earns

- **Lightning swap fee:** for example 1% on top of Fastspot's fee.
- **Later:** a fee from our own staking pool as the default Grow validator, and Community Council funding.

## Risks and open questions

- **Fastspot (blocks Phase 2):**
  - Do they offer Lightning to NIM swaps through the API?
  - Can a third-party service get a partner key and swap on behalf of its users?
  - Can the NIM be released straight to the end user, or must it come to us first?
- **Legal (blocks mainnet for Phase 2, and real prizes in the draw):**
  - The weekly draw is a prize promotion, and prize draws are regulated in most countries.
  - The Lightning swap service may count as an exchange service.
  - Get advice for Nigeria (SEC), Kenya (CMA) and the EU (MiCA) before real money.
- **Adoption:** save codes only work if paying apps integrate. Do the first integrations ourselves.
- **Access:** Grow takes 12 to 24 hours to withdraw, and up to 4 days if the validator is jailed. Show this before anyone deposits.
- **Auto-save reach:** confirmed only for Alby Hub. No African Lightning wallet supports NWC yet, so auto-save mainly reaches Bitcoin users outside Africa; Africans can still make one-off sends.
- **To test on testnet:**
  - an add-stake from an outside account into a real Nimiq Pay user's stake;
  - whether Nimiq Pay's history shows those payments;
  - the deep-link format for opening Errand from a shared code.

## Facts checked (4 November 2026)

| Fact | Source |
|---|---|
| Anyone can add to an existing stake without the owner's signature; pools do this daily (type `06` add-stakes). Added stake goes to the active balance; it fails only if the validator was deleted. | Albatross docs; `staker.rs`; mainnet staking-contract history |
| Minimum stake is 100 NIM (active plus inactive is 0 or at least 100 NIM). Withdrawal lock-up starts at the next election block and lasts one epoch (43,200 one-second blocks); jail lasts 8 epochs. | `getPolicyConstants`; `policy.rs`; `staker.rs` |
| Nimiq Pay's receive address is the user's local address, which is also their staker address and their message-signing key; `listAccounts` returns it first. Mini Apps can only add stake to the user's own stake. | Nimiq Pay source |
| A server can build and sign add-stake and basic payments with `@nimiq/core` 2.23.0 in Node; the public node `rpc.nimiqwatch.com` allows `sendRawTransaction`, `getTransactionByHash` and `getTransactionsByAddress` (with memos). | Local test (throwaway key, not sent); RPC calls |
| Add-stakes paid by others don't appear in the staker's own history. | Mainnet check |
| The public node's `sendRawTransaction` answers with the transaction's hash for anything it can parse: a payment from an empty wallet, a duplicate, one signed for mainnet, and one long expired. None of them land, so only `getTransactionByHash` proves a payment went through. The latest block's `network` field names the chain (`MainAlbatross`, `TestAlbatross`). | Testnet check with empty throwaway wallets; `getLatestBlock` on both networks |
| Fastspot is run by Inuit International Operations Ltd (UK). It uses non-custodial atomic swaps and requires a partner API key. Its terms allow trading only assets "that belong to you". Lightning (`BTC_LN`) is modelled on both sides of a swap in its client library; whether Lightning to NIM is live for outside services is unconfirmed. | fastspot.io/terms; `@nimiq/fastspot-api` 1.10.3 and 2.0.0-beta.2; public `/assets` |
| Alby Hub's `/apps/new` link supports `max_amount` (millisats per period), `budget_renewal` (`daily`, `weekly`, `monthly`, `yearly`), `expires_at` and `request_methods`. 20 wallets support NWC; budget support elsewhere is unconfirmed. | Alby Hub README; awesome-nwc list |
