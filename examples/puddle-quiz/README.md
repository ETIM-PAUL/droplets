# Puddle Quiz: a sample app for trying Droplets

A tiny app that pays NIM. Someone answers three questions, gives an address (or a Droplets save code) and gets a reward. It is written the way any third-party app would use Droplets, so you can test the whole thing as the app's side, and let other people test it as savers.

The Droplets part is one call in [server.ts](server.ts):

```ts
const r = await payer.pay({ to: target.to, luna: REWARD, payoutId, memo: "Puddle Quiz reward" });
```

If the person allowed Puddle Quiz in Droplets, the reward splits between their wallet and their savings. If not, it is one normal payment. The app never has to know which.

## Run it

From the repo root:

```sh
pnpm install
# settings are the PUDDLE_ lines in the repo's main .env; fill in PUDDLE_DROPLETS_KEY (step 3 below)
pnpm --filter puddle-quiz start
```

The first start makes a payout wallet (the key goes to `.data/wallet.key`, never to the page or the log) and prints its address:

```
Payout wallet: NQ89 QQB9 …   balance: 0 NIM
```

## Set it up with Droplets

1. **Register the app.** On the Droplets landing page, under *For apps*, register **Puddle Quiz** (exactly that name) with the payout wallet address from the start-up message. Or add it on the admin page, which also gives you the key at once.
2. **Approve it** on the admin page (`/admin`), if you registered through the landing page.
3. **Put the key in the main `.env`** as `PUDDLE_DROPLETS_KEY=rk_save_…`, then restart. (A `.env` in this folder, without the prefix, works too, as do real environment variables.) Only `PUDDLE_` names are read from the main `.env`, so nothing else in it reaches this app.
4. **Fund the wallet** with a little NIM. Each reward is 5 NIM, and the app stops at 50 NIM a day (`REWARD_NIM`, `DAILY_CAP_NIM`).

Everything is mainnet by default, like Droplets. For testnet NIM that isn't real, set `NETWORK=test` and point `DROPLETS_API_URL` at a testnet Droplets API.

## Let people test it

People need a web address for it. Either:
- run it on your computer and share a tunnel (for example `cloudflared tunnel --url http://localhost:3000`), or
- deploy it as a web service (Render works): leave the root directory as the repo root, build `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @droplets/save build && pnpm --filter puddle-quiz build`, start `pnpm --filter puddle-quiz exec tsx server.ts`. (The SDK is built first because it is linked from this repo; once it is on npm you can install it from there.) Set `NODE_VERSION` to 22. Free hosts lose their disk on restart, so set `PAYOUT_KEY` (the wallet's private key, in the host's secret settings) instead of relying on `.data`.

It works in any browser, and inside Nimiq Pay too.

**What a tester does:**
1. Set up Droplets: open Grow and set a saving rule. Copy the save code.
2. Open Puddle Quiz and paste the save code. Droplets confirms the code before any questions appear.
3. Answer three questions (two right wins) and claim.
4. See the reward split, then check Activity in Droplets: the saved part shows there.

**Only people with Droplets can play.** A save code exists only for someone who has set up Droplets, and Droplets answers "no such code" for anything else, so the app checks the code before the quiz starts and again when paying. Droplets deliberately doesn't let an app check whether a plain address belongs to a saver, so a code is the only honest proof. To also accept plain addresses (those people just get paid in full), set `REQUIRE_DROPLETS=no`.

**Questions don't repeat.** There are 12 questions, and each person gets three they haven't had. After four quizzes they've seen them all and are told to come back. Add questions to `BANK` in `server.ts`.

## What it shows

- **Retry safety.** Signed payouts are written to `.data/payouts.json` before they are sent, and one person can claim once a day. A repeat claim shows the first result instead of paying again. A real app would keep this in its database.
- **Never blocked by Droplets.** If Droplets is slow or down, the SDK pays normally.
- **Keys stay on the server.** The page only gets amounts and transaction hashes.

Outside this repo, install the SDK with `npm install @droplets/save @nimiq/core` instead of the workspace link in `package.json`.
