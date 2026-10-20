/**
 * How often reconciliation asks PayPal about a payment. Frequent while something
 * is likely to change, then rarer — and never once there is nothing left to learn.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A checkout the buyer hasn't finished: did they approve and close the tab? Did it expire? */
export const ORDER_CHECK_DELAYS_MS = [15 * MIN, HOUR, 3 * HOUR, 12 * HOUR, DAY];
/** PayPal keeps an unfinished order about 3 days; after that the checkout is over. */
export const ORDER_ABANDON_AFTER_MS = 3 * DAY;
/** A capture PayPal holds as PENDING (e.g. an eCheck) until it settles either way. */
export const PENDING_CAPTURE_DELAYS_MS = [15 * MIN, HOUR, 6 * HOUR, DAY];
/** A completed sale, watched for refunds made directly in PayPal; then left alone. */
export const REFUND_WATCH_DELAYS_MS = [DAY, 7 * DAY, 30 * DAY, 90 * DAY, 180 * DAY];

/** The n-th delay of a schedule; past its end, the last one repeats (or null if `stopAtEnd`). */
export function scheduled(delays: number[], count: number, stopAtEnd = false): number | null {
  if (count < delays.length) return delays[count]!;
  return stopAtEnd ? null : delays[delays.length - 1]!;
}

export const after = (ms: number | null, from = new Date()) => (ms === null ? null : new Date(from.getTime() + ms));

/** Only within this window after checkout does reconciliation capture on a buyer's behalf — the
 *  same window in which a new checkout by that buyer reuses the order, so they can't pay twice. */
export const CAPTURE_ON_BEHALF_WINDOW_MS = 2 * HOUR;
/** A checkout PayPal says it doesn't know is closed only after this long (and a second "not found"). */
export const ORDER_NOT_FOUND_GRACE_MS = 3 * HOUR;
/** A pending capture still pending after this long needs a person. */
export const PENDING_CAPTURE_GIVE_UP_MS = 30 * DAY;
/** PayPal only rejects a reused sender_batch_id for 30 days: never resend a batch older than this. */
export const RESEND_SAFE_FOR_MS = 25 * DAY;

/**
 * Refund watch: checks at fixed points after the capture (not "the n-th check"), so
 * extra manual checks never use the schedule up. Null once the last point has passed.
 */
export function nextRefundCheck(capturedAt: Date, now = new Date()): Date | null {
  for (const d of REFUND_WATCH_DELAYS_MS) {
    const at = capturedAt.getTime() + d;
    if (at > now.getTime()) return new Date(at);
  }
  return null;
}

/** Wakes the reconciliation worker when something new is scheduled (set by the server). */
let scheduledListener: ((at: Date) => void) | null = null;
export function setReconcileListener(fn: ((at: Date) => void) | null) {
  scheduledListener = fn;
}
export function notifyScheduled(at: Date | null) {
  if (at) scheduledListener?.(at);
}
