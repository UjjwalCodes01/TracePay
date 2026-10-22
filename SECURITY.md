# Security policy

TracePay moves money (PayPal Orders, Payouts and prepaid answer credit), so we take
reports seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's
[private vulnerability reporting](https://github.com/UjjwalCodes01/TracePay/security/advisories/new)
for this repository. Include what you found, how to reproduce it, and its impact.
You'll get an acknowledgement within 3 working days and a fix or plan within 14.

In scope: the API (`apps/api`), the web app (`apps/web`), the MCP server
(`packages/mcp`) and the deployment configuration in this repository.

Out of scope: PayPal, Google (Gemini/Vertex AI), Render, Neon and Vercel themselves —
report those to the vendor. The hosted demo runs on the **PayPal sandbox** with fictional
data; please don't run load tests or automated scanners against it.

## How TracePay is built to stay safe

- Money only moves on a server-verified PayPal capture; payouts use idempotent,
  never-resent-after-25-days batch ids and are reconciled with PayPal on a schedule.
- AI never decides: the license compiler, citation audit and pricing are deterministic;
  model output can't authorize or move money, and text inside sources is treated as data.
- Every state change is in a hash-chained audit log; receipts are Ed25519-signed.
- Passwords use scrypt; sessions and API keys are stored hashed; cookie requests need a
  same-origin check; rate limits are shared across instances.

See the README's *Production readiness* section for details.
