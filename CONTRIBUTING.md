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
npm run keys:generate -w @tracepay/api         # paste AUDIT_SIGNING_PRIVATE_KEY into apps/api/.env
npm run db:deploy -w @tracepay/api && npm run db:seed -w @tracepay/api
npm run dev:api & npm run dev:web
```

## Before you open a pull request

```bash
npm run typecheck -w @tracepay/api && npm run typecheck -w @tracepay/web && npm run typecheck -w @tracepay/mcp
npm run test:coverage -w @tracepay/api         # real Postgres + Redis, fake PayPal, coverage floor
npm run build -w @tracepay/web
npm run test:e2e -w @tracepay/api              # the web app in a browser (needs Chrome/Chromium/Firefox)
```

- Money paths need tests for the failure cases (lost responses, retries, races), not just the happy path.
- Schema changes go in a new Prisma migration; never edit one that has shipped.
- Keep user-facing text plain: no internal status names or jargon.
- Report security issues privately — see [SECURITY.md](SECURITY.md).

## Writing for users

TracePay is used by researchers, publishers and buyers — not accountants or developers.
Every word on a screen should make sense to someone seeing it for the first time.

- **Say what happens, in everyday words.** "Paid", not "captured"; "license check", not
  "preflight"; "contributors' shares", not "settlement lines".
- **One name for one thing**, everywhere:

  | Use | Not |
  |---|---|
  | report | artifact, deliverable |
  | source | asset |
  | contributor (people whose work is licensed and paid) | author, licensor, payee |
  | publisher | licensee, merchant |
  | license check | preflight, license compiler, rules engine |
  | contributors' shares / payment split | settlement, settlement lines |
  | paid (by PayPal) | captured |
  | PayPal payment ID | capture ID |
  | of each sale | of gross |
  | where it came from | provenance |
  | receipt | audit receipt |
  | library fee | platform fee |

- **Never show raw values**: enum names (`payout_submitted`), internal ids
  (`lic_northwind_v1`), cents arithmetic (`floor(2000¢ × 2500 / 10000)`) or hashes.
  Show plain words first; put the exact proof (formulas, hashes, ids, signatures) behind a
  "Technical details" control — it's evidence, so keep it reachable.
- **Money**: always `$1.23` (use `formatMoney`), never cents; describe formulas with
  `describeFormula`.
- **Say what to do next** in empty states and errors, and whether money moved
  ("Nothing was charged").
- **Sentence case** for titles and buttons; no exclamation marks in errors.

The API reference and the Developers page may use technical terms — their readers are developers.
