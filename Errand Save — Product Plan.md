# Errand Save — Product Plan

Working name. Written 4 November 2026. Replaces the earlier save-codes plan.

## What it is

One savings account inside Nimiq Pay, with three ways in and two places to keep the money.

**Ways in**
1. **Save code.** Other Mini Apps pay rewards, bounties and cashback using the user's code. Each payment splits by the user's rule, for example 30% to savings and 70% to the wallet.
2. **Bitcoin Lightning.** The same code is also a Lightning address. Anyone can send sats from any Lightning wallet, and they arrive as NIM savings. Users with a supported wallet can also save automatically every week.
3. **Direct.** The user moves NIM from their own wallet into savings.

**Places to keep it**
- **Grow:** staked NIM in the user's own account. It earns staking rewards and follows NIM's price. Withdrawing takes 12 to 24 hours.
- **Steady:** NIM counted in dollars. Its dollar value stays the same because the other side of the pool, **Boost**, absorbs NIM's price moves. Withdrawals go out at the next daily settlement.

**Boost** is for NIM holders who want more upside. They take the Steady side's price moves, for about 2x NIM's gains and losses when both sides are the same size.

**Example.** Amaka sets "save 30%, half Grow, half Steady".
- An arcade game pays her 2,000 NIM with her code. 600 NIM goes to savings (300 Grow, 300 Steady) and 1,400 NIM to her wallet.
- Her uncle in London sends 20,000 sats to `7kq2xmp@<our domain>` from his Lightning wallet. They arrive as NIM and follow the same rule.

## One code, two forms

- **Save code:** `SAVE-7KQ2XMP`, entered in any Mini App that pays NIM.
- **Lightning address:** `7kq2xmp@<our domain>`, used from any Lightning wallet.

Both point to the same user and the same rule. The rule has two settings:
- **How much to save:** 0 to 100% of each payment.
- **Where savings go:** Grow, Steady, or a mix (for example 50/50).

The code is 6 random characters plus 1 check character, using Crockford base32 (`0-9`, `A-Z` without `I L O U`) with a Luhn mod 32 check character. That allows about 1.07 billion codes. Input ignores case, spaces and dashes, and reads `O` as `0` and `I`/`L` as `1`. There is one active code per address; users can revoke it and get a new one. The code isn't a secret: a lookup reveals only the address, the rule and which savings are open. Lookups need an app key and are rate-limited.

## Routing: where each payment goes

Every payment, whether NIM from an app or sats from Lightning, is split by the same function:

1. **Savings part:** `floor(amount × savePercent / 100)` in luna. The wallet gets the rest.
2. **Within the savings part:** the Steady share goes to Steady and the rest to Grow.
3. **Fallbacks, applied in order:**
   - If **Grow isn't open** (no stake, or the user's validator was deleted), the Grow part goes to Steady if the user uses Steady, otherwise to the wallet.
   - If **Steady is full** (Boost can't cover more, see below), the Steady part goes to Grow if it's open, otherwise to the wallet.
   - If a part comes out at 0, it isn't sent.

| Destination | From an app (save code) | From Lightning |
|---|---|---|
| Wallet | Normal payment to the user's address | Our swap account pays the user's address |
| Grow | The app sends an add-stake into the user's stake | Our swap account sends an add-stake into the user's stake |
| Steady | The app pays the pool address with a memo naming the user | Already in our hands after the swap; credited to the user's Steady balance |

Add-stake needs no signature from the user, so apps (and our swap account) can pay straight into a user's Grow savings. Staking pools do this daily on mainnet.

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

## Steady and Boost: the two-sided pool

### How it works

One pool of NIM, held at a public address we control.

- **Steady** balances are kept in dollars. At each daily settlement, every Steady user is owed `dollar balance ÷ NIM price` in NIM.
- **Boost** balances are shares of whatever NIM is left after Steady is covered.

Example, with NIM at $0.000278. Ada puts 1,000,000 NIM ($278) into Steady and Tunde puts 1,000,000 NIM into Boost.

| NIM price next day | Ada (Steady) | Tunde (Boost) |
|---|---|---|
| Falls 20% | 1,250,000 NIM, still $278 | 750,000 NIM, down 40% in dollars |
| Rises 20% | 833,333 NIM, still $278 | 1,166,667 NIM, up 40% in dollars |

### Rules

- **Daily settlement** at a fixed time, for example 12:00 UTC.
- **Price** is the median of several sources (CoinGecko plus exchange APIs). Settlement pauses if the sources disagree by more than a set margin or the price moves abnormally.
- **Orders fill at the next settlement price,** never the last one. That includes deposits, withdrawals and switches between sides, so nobody can enter Steady after seeing a fall coming.
- **Cover rule.** Steady accepts new money only while Boost NIM is at least equal to the NIM Steady is owed. With equal sides, Steady is protected against any one-day fall of up to 50%.
- **A crash beyond cover.** If Steady is owed more NIM than the pool holds, Steady users share the whole pool in proportion to their dollar balances, and Boost gets nothing. This must be shown to users before they join.
- **Fee:** for example 1% a year on both sides, taken daily.

### Settlement maths

At price `P` (USD per NIM), with the pool holding `N` NIM:

- Steady is owed `C = Σ Steady dollars ÷ P`.
- If `C ≤ N`: each Steady user gets `their dollars ÷ P`, and Boost users share `N − C` by their shares.
- If `C > N`: Steady users share `N` by their dollar balances (their dollar balances shrink to match), and Boost gets 0.

Then the daily fee is applied to both sides, and the queued deposits, withdrawals and switches fill at `P`.

### Proof of reserves

A public page shows two figures every day: the pool address's on-chain balance, and the total NIM owed to both sides. Anyone can check that the first covers the second.

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

## Withdrawals

| From | How | Timing |
|---|---|---|
| Grow | The three Nimiq Pay steps above | 12 to 24 hours; up to 4 days if the validator is jailed |
| Steady | Request in Errand; paid in NIM to the user's wallet at the next settlement | Up to 24 hours |
| Steady → Grow | Request in Errand; the pool sends an add-stake into the user's stake at the next settlement | Up to 24 hours |
| Boost | Same as Steady | Up to 24 hours |

## System design

### API (`apps/api`)

- **Codes and rules:** create, update and revoke a code with a signed message, the same as the earlier plan. The signed text includes the rule: "Save: 30%, Steady: 50%".
- **`GET /v1/save/split?code=&luna=`:** returns the wallet, Grow and Steady parts, plus whether each destination is open. It applies the fallbacks.
- **Receipts:** apps report transaction hashes, and we verify each on-chain. Add-stakes paid by others don't appear in a staker's own history, so receipts are how the "saved, by source" view works. Pool deposits are checked against the pool address's history.
- **Pool service:**
  - a deposit watcher for the pool address, reading memos;
  - a ledger of positions;
  - the price feed;
  - the daily settlement job;
  - payouts;
  - the reserves page.
- **Lightning service:**
  - the LNURL-pay endpoints (`/.well-known/lnurlp/<code>`);
  - the swap orchestrator;
  - the NWC client for weekly auto-save, with connection secrets encrypted at rest.

**Storage.** Postgres (`DATABASE_URL`, following `PgOpsStore`):
- `save_codes`, `save_apps`, `save_receipts`, `save_nonces`;
- `pool_positions`, `pool_orders`, `pool_settlements`;
- `ln_swaps`, `nwc_connections`.

### SDK for paying apps (`@railkit/save`)

`payer.pay({ code, luna, payoutId })` looks up the split and sends up to three transactions:
- a basic payment to the wallet;
- an add-stake for Grow;
- a payment to the pool address, with a memo, for Steady.

It then reports the receipts. Retrying with the same `payoutId` reuses the transactions already sent. The app's key never leaves its server.

### Keys

- **Pool wallet.** Keep most funds in a cold address and only the next day's expected withdrawals in the hot address. Withdrawals are batched at settlement, so the hot balance can stay small.
- **Swap account.** It only receives NIM from swaps and forwards it within seconds. Alert if its balance doesn't return to near zero.

## Screens in Errand

- **Savings home:**
  - Grow balance in NIM, and Steady balance in dollars and naira;
  - money in, by source (apps, Lightning, direct);
  - the code and Lightning address card;
  - "Change rule".
- **Set up:**
  1. Choose how much to save and where (Grow, Steady or a mix), with an example.
  2. Open Grow if needed.
  3. Sign.
  4. Get the code and Lightning address.
- **Share:** the code, the Lightning address, a QR code for each, and copy and share buttons.
- **Weekly auto-save:** connect a wallet (Alby Hub), pick an amount, and see the connection's status.
- **Steady:** the balance, how protection works, the cover level today, the next settlement time, and deposit and withdraw.
- **Boost:** for NIM holders. Shows the balance, the current leverage, the risks in plain words, and deposit and withdraw.
- **Withdraw:** one flow per destination, with the timing shown.
- **Reserves:** the public proof-of-reserves page.

## Rollout

| Phase | Depends on | What ships |
|---|---|---|
| 1. Save codes + Grow | Nothing external | Codes, rules, routing, receipts, the SDK and screens; testnet first, then a mainnet pilot with three apps that already pay NIM. Competition entries are open source, so we can open the integration pull requests ourselves. |
| 2. Steady and Boost pilot | Legal review | The pool with deposit caps, the price feed, daily settlement and the reserves page; Steady added as a code destination. Our team seeds Boost so Steady has cover from day one. |
| 3. Lightning | Fastspot's answer | Lightning addresses for one-off sends, then weekly auto-save through NWC. This phase moves earlier if Fastspot agrees quickly. |

Ask Fastspot now, in parallel with Phase 1.

## What the team earns

- **Pool fee:** for example 1% a year on Steady and Boost balances.
- **Lightning swap fee:** for example 1% on top of Fastspot's fee.
- **Later:** a fee from our own staking pool as the default Grow validator, and Community Council funding.

## Risks and open questions

- **Fastspot (blocks Phase 3):**
  - Do they offer Lightning to NIM swaps through the API?
  - Can a third-party service get a partner key and swap on behalf of its users?
  - Can the NIM be released straight to the end user, or must it come to us first?
- **Legal (blocks mainnet for Phases 2 and 3):**
  - Steady and Boost are likely to be seen as a derivative, and we hold the pool.
  - The Lightning swap service may count as an exchange service.
  - Get advice for Nigeria (SEC), Kenya (CMA) and the EU (MiCA) before real money.
- **Pool:**
  - **Price feed:** NIM trades thinly; use the median of several sources and the pause rule.
  - **Not enough Boost:** if Boost demand is low, Steady fills up, and the routing falls back to Grow.
  - **Our own Boost:** if our team seeds Boost, we carry 2x NIM price risk.
- **Adoption:** save codes only work if paying apps integrate. Do the first integrations ourselves.
- **Access:** Grow takes 12 to 24 hours to withdraw, and up to 4 days if the validator is jailed. Steady and Boost take up to a day. Show this before anyone deposits.
- **Auto-save reach:** confirmed only for Alby Hub. No African Lightning wallet supports NWC yet, so auto-save mainly reaches Bitcoin users outside Africa; Africans can still make one-off sends.
- **To test on testnet:**
  - an add-stake from an outside account into a real Nimiq Pay user's stake;
  - whether Nimiq Pay's history shows those payments;
  - the deep-link format for opening Errand from a shared code;
  - a full settlement cycle with deposits and withdrawals.

## Facts checked (4 November 2026)

| Fact | Source |
|---|---|
| Anyone can add to an existing stake without the owner's signature; pools do this daily (type `06` add-stakes). Added stake goes to the active balance; it fails only if the validator was deleted. | Albatross docs; `staker.rs`; mainnet staking-contract history |
| Minimum stake is 100 NIM (active plus inactive is 0 or at least 100 NIM). Withdrawal lock-up starts at the next election block and lasts one epoch (43,200 one-second blocks); jail lasts 8 epochs. | `getPolicyConstants`; `policy.rs`; `staker.rs` |
| Nimiq Pay's receive address is the user's local address, which is also their staker address and their message-signing key; `listAccounts` returns it first. Mini Apps can only add stake to the user's own stake. | Nimiq Pay source |
| A server can build and sign add-stake and basic payments with `@nimiq/core` 2.23.0 in Node; the public node `rpc.nimiqwatch.com` allows `sendRawTransaction`, `getTransactionByHash` and `getTransactionsByAddress` (with memos). | Local test (throwaway key, not sent); RPC calls |
| Add-stakes paid by others don't appear in the staker's own history. | Mainnet check |
| Fastspot is run by Inuit International Operations Ltd (UK). It uses non-custodial atomic swaps and requires a partner API key. Its terms allow trading only assets "that belong to you". Lightning (`BTC_LN`) is modelled on both sides of a swap in its client library; whether Lightning to NIM is live for outside services is unconfirmed. | fastspot.io/terms; `@nimiq/fastspot-api` 1.10.3 and 2.0.0-beta.2; public `/assets` |
| Alby Hub's `/apps/new` link supports `max_amount` (millisats per period), `budget_renewal` (`daily`, `weekly`, `monthly`, `yearly`), `expires_at` and `request_methods`. 20 wallets support NWC; budget support elsewhere is unconfirmed. | Alby Hub README; awesome-nwc list |
| NIM price $0.000278 on 3 November 2026. | CoinGecko |
