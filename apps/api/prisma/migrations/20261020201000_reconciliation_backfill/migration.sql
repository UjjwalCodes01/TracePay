-- Enrol everything already in flight with the reconciliation worker: it checks each
-- one with PayPal once, then keeps a schedule (or stops if nothing is left to check).

-- Payout batches of settlements that aren't finished.
UPDATE "PayoutBatch" AS b
SET "nextPollAt" = CURRENT_TIMESTAMP
FROM "SettlementRun" AS r
WHERE b."runId" = r.id
  AND r.status IN ('approved', 'payout_submitted', 'exception');

-- Payments still waiting (abandoned or approved-but-uncaptured checkouts) and
-- captured sales (refunds made directly in PayPal).
UPDATE "PayPalPayment" AS p
SET "nextCheckAt" = CURRENT_TIMESTAMP
FROM "Sale" AS s
WHERE p."saleId" = s.id
  AND s.status IN ('pending_payment', 'captured');
