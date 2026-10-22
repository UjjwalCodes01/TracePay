# Contributing

Thanks for helping. TracePay is a TypeScript monorepo (npm workspaces):

| Path | What |
|---|---|
| `apps/api` | Express 5 API, Prisma 7 (PostgreSQL), PayPal, Gemini |
| `apps/web` | React 19 + Vite web app |
| `packages/shared` | Code shared by both (license terms, the settlement engine) |
| `packages/mcp` | MCP server for AI agents |

## Setup

Node 24 (`.node-version`), Docker. Then:

```bash
npm ci
npm run db:up                                  # Postgres :5433, Redis :6380
cp apps/api/.env.example apps/api/.env         # add PayPal sandbox keys
npm run db:deploy -w @tracepay/api && npm run db:seed -w @tracepay/api
npm run dev:api & npm run dev:web
```

## Before you open a pull request

```bash
npm run typecheck -w @tracepay/api && npm run typecheck -w @tracepay/web && npm run typecheck -w @tracepay/mcp
npm run test:integration -w @tracepay/api      # real Postgres + Redis, fake PayPal
npm run build -w @tracepay/web
```

- Money paths need tests for the failure cases (lost responses, retries, races), not just the happy path.
- Schema changes go in a new Prisma migration; never edit one that has shipped.
- Keep user-facing text plain: no internal status names or jargon.
- Report security issues privately — see [SECURITY.md](SECURITY.md).
