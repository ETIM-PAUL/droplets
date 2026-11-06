# RailKit

Ramp, Lightning and x402 SDK, and the engine behind the Errand Mini App. MIT licensed.

## Layout

- `apps/` miniapp, api, dashboard, docs
- `packages/` core, client, wallet-nimiq, wallet-evm, adapters, widgets, x402, agent, save

## Develop

```sh
pnpm install
pnpm ci   # typecheck, test, build, licence check
```

Run the API and the Mini App together (the Mini App proxies `/api` to the API, so one ngrok tunnel serves both):

```sh
cp .env.example .env            # fill in the keys
pnpm --filter @railkit/api dev  # http://localhost:8787
pnpm --filter @railkit/miniapp dev
pnpm test:contract              # live checks against Mavapay staging (no real money)
```

`CORRIDORS` in `.env` is the kill switch: only the corridors listed there are served.

CI blocks GPL, AGPL and LGPL production dependencies. Every PR gets a preview deploy of the Mini App (needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets).

## Chat (sentence to quote)

`POST /v1/agent/understand` turns "Send ₦5,000 to 0123456789 GTBank" into a checked draft and the next question.
Plain rules read most sentences for free. Only when they leave a gap is the model (`OPENAI_API_KEY`, `OPENAI_MODEL`) asked, at most `AGENT_MODEL_CALLS_PER_DAY` times a day.
Every value the model returns must appear in the user's own words, or it is dropped and the user is asked.
The model never sees keys or balances, and its output can't send anything: only the confirm card's Send button and Nimiq Pay's own dialog can.
Savings sentences ("save 30% of what apps pay me", "put 500 NIM in Grow", "take 200 NIM out of savings") are read by the rules alone, never the model, and only open the Savings screen with the values filled in.
Savings questions ("when can I get my money?", "why did that payment go to my wallet?") are answered in the chat by `POST /v1/save/ask`: code works out the answer from the user's own data. For questions that aren't in English, a model may pick which question it is from a fixed list and reword the answer, but a rewording is shown only if it keeps every number and the save code exactly; otherwise the English answer is.

## Evals and the signing guard

- `pnpm test` runs the eval set ([packages/agent/src/evals/sentences.ts](packages/agent/src/evals/sentences.ts)) on the rules. The bar is zero wrong values and at least 95% recall. CI fails below it.
- `pnpm eval:model` runs the same set with the real model (about $0.02). Run it before changing the prompt or the model. The bar is still zero wrong values.
- [packages/agent/src/injection.test.ts](packages/agent/src/injection.test.ts) pairs a hostile model with every eval sentence and with QR text. Nothing it invents may survive.
- `pnpm check:signing` (in CI) fails the build if:
  - code uses a raw signing or key API;
  - server or untrusted-input code imports a wallet;
  - a wallet executor is created anywhere other than the Send/Pay tap handlers;
  - a savings action (`createNimiqSaver`) is created anywhere other than the Savings tap handlers;
  - a key pair appears anywhere but the server payout SDK (`packages/save/src/payer.ts`), or the phone or the API imports it;
  - the developer test page is reachable without `VITE_TEST_PAGE=true`.
- Add every real misread from the beta to the eval set.

## Errand Save (phase 1)

Save codes and Grow: users choose a share of every NIM payment to save, signed once in Nimiq Pay. Apps that pay rewards look up the split with the user's save code and pay the user directly: part as a normal payment, part as an add-stake into the user's own stake. Errand never holds the money.

- Plan: [Errand Save — Product Plan.md](Errand%20Save%20—%20Product%20Plan.md). Guide for paying apps: [packages/save/README.md](packages/save/README.md).
- Switch it on with `SAVE_ENABLED=true`, `SAVE_NETWORK` (start with `testnet`) and `VITE_SAVE_ENABLED=true`. Register paying apps with `POST /v1/admin/save/apps`.
- Code: `packages/core/src/save.ts` (codes, signed rules, splits), `apps/api/src/save/`, `packages/save` (SDK for paying apps), `apps/miniapp/src/save/SaveHome.tsx`.

### Steady and Boost (feature 2)

A two-sided pool inside Savings: Steady balances keep their dollar value, Boost takes NIM's moves for both sides (about 2x when both sides are the same size). Settles once a day at the median of three price sources. Errand holds this pool's NIM, so it is off by default, testnet first, and needs `POOL_ALLOW_MAINNET=true` on top of `POOL_NETWORK=mainnet` (after the legal review).

- Settlement maths: `packages/core/src/pool.ts` (pure, tested for never creating or losing NIM). Books and jobs: `packages/pool`. Orders and reserves: `apps/api/src/pool/`. The worker that holds the pool's key: `apps/pool-worker`. Screen: `apps/miniapp/src/save/PoolHome.tsx`.
- Running it: `docs/pool-runbook.md`, kept local with the other runbooks.

## Deploy (Render)

[render.yaml](render.yaml) deploys the API (`errand-api`), the Mini App (`errand-miniapp`) and Postgres (`errand-db`) from this repo.

1. Push the repo to GitHub. `.env` is gitignored and never leaves your machine.
2. In Render: **New > Blueprint** and pick the repo. Render asks once for each secret (`sync: false`). Paste the same values as in your `.env`.
3. After the first deploy, fill the addresses in:
   - `errand-api`: `ALLOWED_ORIGINS` = the Mini App's URL, and `PUBLIC_API_URL` = the API's URL.
   - `errand-miniapp`: `VITE_RAILKIT_API_URL` = the API's URL. Saving this rebuilds the app.
4. Give testers invite codes (`node scripts/new-invites.mjs`, then put the output in `BETA_INVITES`). They open the Mini App URL inside Nimiq Pay.
5. Provider IP allow-lists (Changelly): `errand-api` > **Connect** > **Outbound** lists the IPs the API calls from.

The free plan sleeps after about 15 minutes idle (the first request then takes about a minute), and free Postgres is time-limited. Move to a paid plan or a VPS before the public beta.
