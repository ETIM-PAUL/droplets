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
