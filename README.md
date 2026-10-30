# RailKit

Ramp, Lightning and x402 SDK, and the engine behind the Errand Mini App. MIT licensed.

## Layout

- `apps/` miniapp, api, dashboard, docs
- `packages/` core, client, wallet-nimiq, wallet-evm, adapters, widgets, x402, agent

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

## Evals and the signing guard

- `pnpm test` runs the eval set ([packages/agent/src/evals/sentences.ts](packages/agent/src/evals/sentences.ts)) on the rules. The bar is zero wrong values and at least 95% recall. CI fails below it.
- `pnpm eval:model` runs the same set with the real model (about $0.02). Run it before changing the prompt or the model. The bar is still zero wrong values.
- [packages/agent/src/injection.test.ts](packages/agent/src/injection.test.ts) pairs a hostile model with every eval sentence and with QR text. Nothing it invents may survive.
- `pnpm check:signing` (in CI) fails the build if:
  - code uses a raw signing or key API;
  - server or untrusted-input code imports a wallet;
  - a wallet executor is created anywhere other than the Send/Pay tap handlers;
  - the developer test page is reachable without `VITE_TEST_PAGE=true`.
- Add every real misread from the beta to the eval set.
