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

CI blocks GPL, AGPL and LGPL production dependencies. Every PR gets a preview deploy of the Mini App (needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets).
