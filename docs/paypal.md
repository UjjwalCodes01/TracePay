# PayPal in TracePay

[README](../README.md) · [How it works](how-it-works.md) · [PayPal](paypal.md) · [Running it](running.md) · [Tests](testing.md)

## How PayPal is used

| PayPal capability | Where | Why it matters |
|---|---|---|
| **OAuth 2.0** client credentials | `integrations/paypal/client.ts` | Token caching; **Payouts scope detection** before promising payouts |
| **Orders v2** — create | `POST /api/checkout/orders` | Created server-side with `reference_id` = `custom_id` = sale id; `PayPal-Request-Id` idempotency |
| **Orders v2** — capture + get | `POST /api/checkout/:saleId/capture` | Server captures, then **verifies** amount, currency and `custom_id` under a row lock; handles `ORDER_ALREADY_CAPTURED` |
| **JS SDK Smart Buttons** | `apps/web/src/pages/Store.tsx` | Buyer approval only; the browser never decides payment state |
| **Payouts** — create batch | `POST /api/settlements/:id/payouts` | One batch per settlement; deterministic `sender_batch_id` recorded **before** the call, so a retry can never pay twice |
| **Payouts** — batch status | `POST /api/settlements/:id/refresh` | "Accepted" ≠ "paid": a run completes only when every item is `SUCCESS`; `FAILED`/`RETURNED`/… become exceptions |
| **Webhooks** + signature verification | `POST /api/webhooks/paypal` | Raw-body verification via `verify-webhook-signature`; deduped by event id; handles `PAYMENT.CAPTURE.COMPLETED/REFUNDED/REVERSED/DENIED` and payout events (status re-read from PayPal, never trusted from the payload) |
| **Captures** — get, and **reconciliation** | `modules/reconciliation/sync.ts` | TracePay doesn't depend on webhooks arriving: it re-reads every in-flight order, capture and payout batch from PayPal on a schedule (see below) |

### Reconciliation: TracePay checks PayPal itself

Webhooks can be missed — a sleeping server, a PayPal outage, a misconfigured endpoint. So every payment and payout batch still in flight carries the time of its next check, and a background worker asks PayPal directly:

| Situation | What TracePay does |
|---|---|
| Buyer approved in PayPal, then closed the tab before the capture | Captures it for them — after re-checking every license — so a paid-for report isn't lost |
| Checkout never finished | Keeps checking for 3 days, then closes it (buyer not charged); immediately if PayPal no longer has the order |
| Capture held as pending (e.g. an eCheck) | Follows it until PayPal completes it (sale + settlement) or declines it (needs attention) |
| Refund or partial refund made in the PayPal dashboard | Notices it (checks 1, 7, 30, 90 and 180 days after the sale), holds the settlement, asks for attention |
| Payout batch in progress | Polls every attempt until every payout is final (1 min → daily), then stops |
| Payout unclaimed, failed, returned, blocked, or batch denied | Opens a plain-language **Needs attention** item; clears it by itself once a retry or claim succeeds |
| Send interrupted mid-request | Finishes it with the same `sender_batch_id`, so PayPal can't pay twice |
| PayPal accepted a batch but its id never arrived | Tells a person after an hour; clears when the webhook brings the id |

Checks are claimed with leases (`SKIP LOCKED`), so several servers share the work without doing anything twice; PayPal errors back off instead of retrying in a loop; and the worker sleeps until the next scheduled check, so an idle deployment lets Neon suspend. Issues are available in the dashboard, at `GET /api/v1/reconciliation/issues`, and as `reconciliation.issue_opened` / `issue_resolved` webhooks.

## Money: fees, and why PayPal is used this way

PayPal's US rates (Oct 2026): checkout **3.49% + $0.49**; Payouts API **$0.25 per payout**; micropayments pricing 4.99% + $0.09.

| Flow | What it costs | How TracePay keeps it sane |
|---|---|---|
| A $20 report sale | $1.19 PayPal fee, paid by the publisher (shown on *Pay contributors*, read from PayPal's capture) | Contributors' shares are worked out from what PayPal actually confirmed |
| Answer credit | A $5 top-up loses 13% to the fixed fee; $20 loses 6%; $50 loses 4.5% | Top-ups start at $5 and the app suggests $10–$50; each answer then spends credit cent by cent with **no** PayPal fee. A production library with many tiny top-ups would use PayPal's micropayments pricing |
| Royalties to contributors | $0.25 per payout | Earnings accrue and are paid in one PayPal Payouts batch once a contributor is owed **$10** (2.5% in fees); `ROYALTY_PAYOUT_MIN_CENTS` sets it. The demo pays from 1¢ so visitors can watch it happen |

**Why Payouts, not a split at checkout.** Today the publisher is the merchant: the buyer pays them, and they pay contributors with PayPal Payouts after approving the split. That works with a standard PayPal business account, and it lets a refund or chargeback claw back unpaid shares before anyone is paid. For a marketplace at scale, the production path is **PayPal Multiparty** (PayPal Complete Payments for platforms): contributors onboard as sellers, and each sale is split at capture with platform fees, so TracePay never holds anyone's money. The license check, the frozen terms and the receipts stay exactly as they are; only the last step changes.

**Holding balances.** Prepaid answer credit is money held for future use and paid on to third parties. In production that needs the right structure (PayPal Multiparty with the library as merchant of record, or a licensed partner holding the funds) and, depending on the jurisdiction, money-transmission licensing. The hackathon build runs only on the PayPal sandbox.
