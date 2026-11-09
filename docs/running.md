# Running TracePay

[README](../README.md) · [How it works](how-it-works.md) · [PayPal](paypal.md) · [Running it](running.md) · [Tests](testing.md)

## Run it locally

**Prerequisites:** Node 24 (see `.node-version`; the MCP server runs TypeScript directly), Docker, a PayPal Developer account. Gemini (an API key or Vertex AI) is optional.

```bash
git clone https://github.com/UjjwalCodes01/TracePay.git && cd TracePay
npm install
npm run db:up                                  # Postgres 17 on localhost:5433, Redis on :6380

cp apps/api/.env.example apps/api/.env         # then fill in the values below
npm run keys:generate -w @tracepay/api         # paste AUDIT_SIGNING_PRIVATE_KEY into .env

npm run db:deploy -w @tracepay/api             # apply migrations
npm run db:seed -w @tracepay/api               # load the demo world

npm run dev:api                                # http://localhost:4000
npm run dev:web                                # http://localhost:5173
```

### Environment (`apps/api/.env`)

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Local Docker URL, or Neon's **pooled** connection string (host contains `-pooler`) |
| `DATABASE_URL_UNPOOLED` | on Neon | Neon's **direct** connection string; used only by `prisma migrate` (needs session-level locks) |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | yes | **Sandbox** REST app. Enable *Payouts* in the app's features |
| `DEMO_PAYEE_EMAILS` | for payouts | Three sandbox **personal** account emails (Northwind, Okafor, Lumen) |
| `PAYPAL_WEBHOOK_ID` | for webhooks | Register `https://<api>/api/webhooks/paypal` in the dashboard |
| `GEMINI_API_KEY` | for live AI | A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey); `GEMINI_MODEL` optional (default `gemini-flash-latest`) |
| `GOOGLE_CLOUD_PROJECT`, `VERTEX_MODEL`, `GOOGLE_CLOUD_LOCATION` | or, for live AI | Vertex AI instead of an API key (the hosted demo uses `gemini-3.5-flash` on the `global` endpoint): `gcloud auth application-default login` locally; on a server, `GOOGLE_SERVICE_ACCOUNT_JSON` (base64 key of a service account with only *Vertex AI User*) — without it, production treats AI as not configured |
| `AUDIT_SIGNING_PRIVATE_KEY` | yes | Ed25519 key from `npm run keys:generate` |
| `DEMO_MODE` | no (default `false`) | `true` enables the one-click demo roles and "Reset demo". **Keep `false` for real users** |
| `DEMO_SHARED_BUYER` | no (default `false`) | With `DEMO_MODE`, for a hosted demo many people visit: the demo buyer may buy a report again and its demo credit refills, so every visitor can try checkout and AI answers. Demo credit still only pays the demo's own contributors |
| `PAYPAL_SANDBOX_BUYER_HINT` | no | Demo mode only: the sandbox buyer login shown next to the PayPal buttons, so visitors can complete a test payment |
| `APP_BASE_URL`, `API_BASE_URL` | in production | The public web address (PayPal return URLs, CSRF) and the API's own public address (OpenAPI servers) |
| `CORS_ORIGINS` | in production | The web app's origin(s); also used for the CSRF origin check |
| `RATE_LIMIT_PER_MINUTE`, `AUTH_RATE_LIMIT` | no | Defaults 300 req/min/IP and 20 sign-in attempts per 15 min/IP |
| `API_RATE_LIMIT_PER_MINUTE` | no | Platform API requests per minute per API key (default 600; twice that per account) |
| `WEBHOOK_SECRET_KEY` | recommended | 32 random bytes (base64/hex) encrypting webhook signing secrets at rest. Without it a key is derived from `AUDIT_SIGNING_PRIVATE_KEY`; adding or changing it later never breaks existing endpoints (old keys go in `WEBHOOK_SECRET_KEY_PREVIOUS`) |
| `WEBHOOK_ALLOW_PRIVATE_TARGETS` | no (default `false`) | Lets webhooks reach `http://` and private/loopback addresses. **Local development only** |
| `CLIENT_IP_HEADER` | no | Edge header with the visitor's IP, for platforms with a variable proxy chain. Not needed on Cloud Run: Google appends the client address to `X-Forwarded-For` and `TRUST_PROXY_HOPS=1` reads it |
| `TRUSTED_PROXY_SECRET` | no | Only when a separate web proxy (e.g. Vercel) forwards `/api` to this service: the shared secret that lets its reported visitor address be used for rate limits. Not used when the API serves the web app itself (the default on Cloud Run) |

## Production readiness

TracePay is built to be adopted after the hackathon, not just demoed.

| Area | What's in place |
|---|---|
| **Accounts** | Sign-up / sign-in with **scrypt** password hashing (OWASP parameters, constant-time compare, timing-safe for unknown emails); server-side sessions in **httpOnly, SameSite=Lax, Secure** cookies — only a SHA-256 of the token is stored |
| **Platform API** | Versioned `/api/v1` described by OpenAPI 3.1, generated from the same declarations that validate requests (tests check every response against it); idempotency keys with heartbeat-held locks, cursor pagination, uniform errors with request ids |
| **API keys** | Hashed at rest, shown once, read-only or read & write, optional expiry, revocable; accepted only on `/api/v1`; guessing is throttled per address without ever blocking working keys; per-key and per-account rate limits |
| **Scaling out** | Rate limits and quotas are counted in a Redis-compatible store (`REDIS_URL`), so they hold across any number of API instances; if it is unreachable each instance falls back to counting in memory — limits never vanish — and `/api/ready` says so. Without `REDIS_URL` they count in memory (exact for one instance). Webhook delivery and reconciliation already coordinate through Postgres (`SKIP LOCKED` leases) |
| **Webhooks** | Events written in the same transaction as the change (outbox); HMAC-SHA256 signatures with timestamps; AES-256-GCM encrypted secrets with overlap-safe rotation; SSRF checks at connection time (DNS rebinding, IPv4-mapped IPv6, no redirects); backoff retries, auto-disable after 3 days or `410 Gone`; leases + `SKIP LOCKED` so several servers never double-send; the worker sleeps when the API is idle so Neon can too |
| **Tenant isolation** | Every build, run, report, sale, settlement and audit event is scoped to its publisher. Other tenants get **404** (not 403), so they can't even confirm a record exists. Buyers see sourcing but not the money split; only the owner sees payout addresses |
| **Request security** | Helmet security headers and a locked-down CSP; CSRF origin check on cookie-authenticated writes; per-IP rate limits with stricter limits on credential endpoints; 1 MB body limit; zod validation on every input |
| **Money safety** | Integer cents, idempotency keys on every PayPal write, row locks on capture, terms frozen per sale, publisher approval before payouts, exceptions for refunds and failed payouts. Pay-per-citation: a ledger whose entries always sum to the balance (checked by tests), worst-case holds so concurrent answers can't overspend, database CHECK constraints on amounts and on charge ≤ limit, per-refund debits, clawback of unpaid royalties, a clearing period before payouts (`CREDIT_CLEARING_DAYS`), payout batches claimed before sending and never resent after 25 days |
| **Reconciliation** | Scheduled, lease-based checks of every in-flight order, capture and payout batch against PayPal (no reliance on webhooks) — answer-credit top-ups and royalty batches included; refunds made outside TracePay detected; abandoned checkouts closed; top-ups approved then abandoned captured on the buyer's behalf; interrupted payout sends finished safely; payouts returned after succeeding re-paid; a "Needs attention" list that resolves itself when the cause clears |
| **Operability** | Structured JSON logs (pino) with request ids echoed in `X-Request-Id` and secrets redacted; `/api/health` (liveness) and `/api/ready` (database, rate-limit store); graceful shutdown on SIGTERM; in production the server **refuses to start** with localhost URLs or missing PayPal/webhook/signing settings; every Gemini call is bounded in time and size; a recovery sweep for work interrupted by a restart |
| **Privacy** | Users can **download all their data** and **delete their account** (anonymised; financial records kept without personal details; refused while money is still owed either way); expired sessions and PayPal webhook payloads are pruned on a schedule; payout-email changes need the password and are audited; publishers never see buyers' PayPal emails; Privacy and Terms pages |
| **Supply chain** | `npm audit` gate in CI, CodeQL (security-extended) on every push, Dependabot for npm and GitHub Actions; [SECURITY.md](../SECURITY.md) for private vulnerability reports |
| **Database** | **Neon** serverless Postgres: the app uses the pooled endpoint, migrations the direct one; the pool survives compute suspend/resume; health checks and an idle API never wake the database; the seed script refuses to run once real accounts exist, and integration tests refuse non-local databases |
| **Self-service licensing** | Contributors register sources (immutable, fingerprinted versions) and offer terms; publishers request, accept or decline. Terms only bind once **both** parties agree, acceptance is tied to the exact terms hash reviewed, renegotiations never displace an active license until accepted, and revocation stops future builds without rewriting past settlements |
| **AI-drafted terms, human-decided** | Gemini drafts normalized terms from a license document, quoting the sentence behind every field; quotes are checked against the document. A deterministic extractor (restrictive by default, with warnings) covers the no-AI case. Nothing is enforced until confirmed by both sides |
| **Auditability** | Hash-chained, tenant-tagged audit log; Ed25519-signed receipts verifiable offline |
| **Delivery** | Versioned Prisma migrations (including data backfills), CI running typecheck, 400 tests with a coverage floor, browser tests and CodeQL against real Postgres, a Dockerfile and Cloud Build config, deployed to Google Cloud Run |

### Deploying (Google Cloud Run)

TracePay runs as one container: the API also serves the built web app from its own origin (`WEB_DIST_DIR`), so there is one host and session cookies stay first-party. The hosted demo runs in `us-east5`, next to its Neon database, with one instance always on and CPU always allocated (no cold starts; PayPal reconciliation and webhook retries keep running between requests). It runs as a service account with only *Vertex AI User* and access to its own secrets, so Gemini needs no key file.

```bash
gcloud builds submit --config cloudbuild.yaml --substitutions=_COMMIT=$(git rev-parse --short HEAD)
bash deploy/cloud-run.sh path/to/production.env   # secrets → Secret Manager, PayPal webhook, deploy
```

`deploy/cloud-run.sh` stores the secrets in Secret Manager (never printed), registers the PayPal webhook for the service's address (`deploy/paypal-webhook.mjs`, same events as before) and deploys. Migrations run when the container starts, retried while Neon wakes.

### Deploying the database (Neon)

1. Create a Neon project (Postgres 17). In **Connect**, copy two strings: the **pooled** one (host contains `-pooler`) → `DATABASE_URL`, and the one with pooling switched off → `DATABASE_URL_UNPOOLED` (`neon env pull` writes both under these names).
2. Put both in the production env file `deploy/cloud-run.sh` reads. Every container start runs `prisma migrate deploy` over `DATABASE_URL_UNPOOLED` before serving.
For local development, `neon init` / `neon deploy` pull both strings into the repo-root `.env.local`; the API's dev, seed and migrate commands load it after `apps/api/.env`, so it takes precedence. Remove `.env.local` to go back to the local Docker database. Integration tests always use the local database.

3. Load the demo data once: `npm run db:seed -w @tracepay/api` with those variables set. It refuses to run once the database has real accounts; use **Reset demo** in the app instead, which only touches the demo personas.

Neon's free plan suspends the compute after a few idle minutes and wakes it on the next query (allow a second or two on the first request). `/api/health` doesn't touch the database, so health checks let Neon sleep.

Check your PayPal setup before running the app:

```bash
npm run smoke:paypal -w @tracepay/api -- token          # auth + Payouts scope
npm run smoke:paypal -w @tracepay/api -- order          # prints an approval link
npm run smoke:paypal -w @tracepay/api -- capture <ORDER_ID>
npm run smoke:vertex -w @tracepay/api                   # Gemini structured output
```

### Demo walkthrough

1. **Publisher** → *Create a report* → keep the three preselected sources → **Start the assistant**. Watch it get blocked, propose a replacement, and wait for you. **Approve replacement** → report ready.
2. Open the report → click a citation chip → **Where it came from**.
3. Switch role to **Buyer** → *Report store* → **Pay with PayPal** (sandbox buyer account) → the report unlocks once the server has verified the payment. Or open *Shopping assistant*, describe what you need, set a budget, and watch it search, verify and propose — then pay (or decline) right on its proposal.
4. Switch back to **Publisher** → *Pay contributors* → **Approve payment split** → **Send PayPal payouts** → **Refresh from PayPal**.
5. Open the **Receipt** → **Check signature**. Switch to a **Contributor** to see their own share of every sale.
6. **Pay-per-citation:** as **Buyer** → *Ask the library* → ask (the demo buyer has demo credit; top up with PayPal for more). See who your cents paid, what was left out and why, and verify the signed receipt. As **Publisher** → *Answer royalties* → **Pay with PayPal** → **Check with PayPal**. As a **Contributor** → *My earnings → From AI answers*.

## Platform API & webhooks

Everything the dashboard does is also available to other software, so a company can plug TracePay into its own stack after the hackathon. (In the API, *preflight* = license check, *settlement* = the contributors' payment split, *artifact* = report, *capture* = a PayPal payment.)

- **REST API at `/api/v1`** — sources and licenses, license preflight, citation-checked generation, reports, signed receipts and provenance, sales, settlements and PayPal payouts, research-assistant runs, and **buying** for buyer accounts (search, license check, PayPal checkout). **OpenAPI 3.1** at [`/api/v1/openapi.json`](https://tracepay-886254253714.us-east5.run.app/api/v1/openapi.json), browsable on the **Developers → API reference** page.
- **API keys** from the Developers page: full or read-only, optional expiry, revocable. Keys work only on `/api/v1` (never on the dashboard's own routes).
- **Signed webhooks** for 35+ event types (`sale.completed`, `settlement.created`, `payout_batch.updated`, `license.offered`, …): HMAC-SHA256 with timestamp, retries with backoff for about a day, secret rotation without downtime, a test button and a delivery log.
- **Safe to retry:** `Idempotency-Key` on every POST; cursor pagination; one error format with request ids; per-key rate limits.

```bash
curl 'https://tracepay-886254253714.us-east5.run.app/api/v1/sales?status=captured' \
  -H "Authorization: Bearer tp_…"
```

---

### AI agents can shop too (MCP)

[`packages/mcp`](../packages/mcp) is an **MCP server** that lets any AI agent — Claude Desktop, an IDE agent — shop for a buyer through the Platform API's **Buying** endpoints (`/store/reports`, `/checkouts`): search, re-check licenses, and buy. **It pays only what the buyer allowed:** within the buyer's spending mandate it pays at once with their saved PayPal (`POST /v1/checkouts` with `pay_with_mandate`); otherwise it hands the buyer PayPal's approve link and only completes a checkout they approved. It refuses anything over its own price cap either way. Buyers create the key on *Connect an AI agent*.

## Real vs. simulated

| Real | Simulated / demo-only |
|---|---|
| PayPal sandbox Orders, capture, Payouts, webhooks (including answer-credit top-ups and per-citation royalty payouts) | All sources, contributors and numbers are fictional |
| License check, payment-split engine, audit chain, signatures | The seeded demo roles, reachable with one click when `DEMO_MODE=true` |
| Accounts: sign-up / sign-in, scrypt passwords, httpOnly sessions, API keys | |
| Gemini agents and writers, through a Gemini API key or Vertex AI (when configured) | Fixture writer / rule-based planner when Gemini is not configured — always labeled |
| PostgreSQL persistence | "Reset demo" restores TracePay fixtures; it does **not** reverse PayPal sandbox history |

TracePay enforces recorded, approved license terms. It does not establish legal ownership of source material, is not legal advice, and is not an escrow service — the publisher receives the payment and then pays contributors.

## Project layout

```
apps/api      Express API, Prisma schema & migrations, services, tests
apps/web      React app (Vite, Tailwind, React Router, TanStack Query, AG Grid, React Flow)
packages/shared  Money helpers and zod schemas shared by API and web
Dockerfile    One container: API + web app (Cloud Run); cloudbuild.yaml builds it, deploy/ deploys it
```

## Tools used

- **PayPal Developer Platform (sandbox):** Orders v2, JS SDK Smart Buttons, Payouts, Webhooks.
- **Google Gemini (Gemini API or Vertex AI):** function-calling research assistant (publisher) and shopping assistant (buyer), structured-output report writer, license drafting, failure explanations — via `@google/genai`.
- **AG Grid Community + AG Charts:**
  - **Price & royalty simulator** (Create a report): an editable grid of prices, each settled in the browser with the same engine that settles real sales (`packages/shared`), with a stacked chart of who gets what.
  - **Royalty ledger** (Pay contributors): every sale's royalty lines with quick search, column filters, totals and a per-recipient chart that follow the filters, CSV export, and cells that flash when PayPal changes a payout.
  - **Contributor earnings** with filters and CSV export (for taxes), plus the source registry and per-sale settlement grids.
- **React Flow:** provenance graph.
- **Google Cloud:** Cloud Run (the whole app, one container), Cloud Build, Artifact Registry, Secret Manager and Vertex AI. **Neon** (serverless Postgres).
- Node.js, TypeScript, Express 5, Prisma 7, PostgreSQL 17, React 19, Tailwind CSS 4, Vitest.
- **Model Context Protocol** (`@modelcontextprotocol/sdk`): the TracePay MCP server for outside AI agents.
