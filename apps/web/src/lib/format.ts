import { formatBps, formatMoney } from '@tracepay/shared';
import type { Economics } from '@tracepay/shared';

export { formatMoney };

export function economicsLabel(e: Economics | null | undefined): string {
  if (!e) return '—';
  if (e.kind === 'percent_of_gross') return `${formatBps(e.bps)} of each sale`;
  if (e.kind === 'fixed_per_sale') return `${formatMoney(e.amountCents)} per sale`;
  return 'No payment';
}

export function timeAgo(iso: string): string {
  // A client clock slightly behind the server's never shows "-5s ago".
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** What each recorded event means, in plain words. Anything new falls back to a readable form. */
const EVENT_LABELS: Record<string, string> = {
  'asset.registered': 'Source added',
  'asset.version_added': 'New version of a source added',
  'license.requested': 'License requested',
  'license.offered': 'License offered',
  'license.accepted': 'License agreed',
  'license.declined': 'License declined',
  'license.request_declined': 'License request declined',
  'license.withdrawn': 'License offer withdrawn',
  'license.revoked': 'License revoked',
  'build.preflight_passed': 'License check passed',
  'build.preflight_blocked': 'License check stopped the report',
  'build.generation_failed': 'Writing the report failed',
  'build.generation_rejected': 'A draft was rejected for bad citations',
  'build.rights_changed': 'A source’s license changed',
  retrieved: 'Passages taken from licensed sources',
  cited: 'Sources cited in the report',
  'artifact.generated': 'Report written',
  'artifact.withdrawn': 'Report taken off sale',
  'artifact.relisted': 'Report back on sale',
  'agent.started': 'Assistant started',
  'agent.awaiting_approval': 'Assistant waiting for approval',
  'agent.replacement_approved': 'Replacement source approved',
  'agent.replacement_declined': 'Replacement source declined',
  'agent.purchase_approved': 'Purchase approved',
  'agent.purchase_declined': 'Purchase declined',
  'agent.completed': 'Assistant finished',
  'agent.cancelled': 'Assistant stopped',
  'agent.failed': 'Assistant failed',
  'sale.created': 'Checkout started',
  'sale.pending': 'Payment pending at PayPal',
  'sale.captured': 'Paid with PayPal',
  'sale.capture_pending': 'Payment pending at PayPal',
  'sale.capture_declined': 'Payment declined',
  'sale.capture_exception': 'Payment needs a look',
  'sale.blocked': 'Sale stopped by a license',
  'sale.blocked_before_capture': 'Sale stopped before payment',
  'sale.checkout_expired': 'Checkout expired',
  'sale.expired': 'Checkout expired',
  'sale.declined': 'Payment declined',
  'sale.exception': 'Payment needs a look',
  'sale.completed': 'Sale complete',
  'sale.refunded': 'Sale refunded',
  'sale.partially_refunded': 'Sale partly refunded',
  'sale.reversed': 'Payment reversed',
  'settlement.created': 'Contributors’ shares worked out',
  'settlement.calculated': 'Contributors’ shares worked out',
  'settlement.recalculated': 'Contributors’ shares worked out again',
  'settlement.approved': 'Payment split approved',
  'settlement.completed': 'All contributors paid',
  'settlement.failed': 'Paying contributors failed',
  'payout.submitted': 'Payouts sent to PayPal',
  'payout.submit_failed': 'PayPal didn’t accept the payouts',
  'payout.status_refreshed': 'Payout status updated from PayPal',
  'payout.retry_created': 'Failed payouts sent again',
  'payout.duplicate_detected': 'PayPal already had these payouts',
  'credits.top_up_started': 'Credit top-up started',
  'credits.topped_up': 'Credit added',
  'credits.top_up_failed': 'Credit top-up failed',
  'credits.top_up_reversed': 'Credit top-up refunded',
  'answer.answered': 'Question answered',
  'answer.not_covered': 'Question not covered',
  'answer.failed': 'Answer failed',
  'royalties.payout_created': 'Royalty payouts prepared',
  'royalties.payout_settled': 'Royalties paid',
  'royalties.payout_rejected': 'PayPal refused the royalty payouts',
  'royalties.payout_submit_failed': 'Royalty payouts weren’t sent',
  'royalties.payout_duplicate': 'PayPal already had these royalty payouts',
  'reconciliation.issue_opened': 'Something needs attention',
  'reconciliation.issue_resolved': 'Issue resolved',
  'account.payout_email_changed': 'PayPal email changed',
  'account.deleted': 'Account deleted',
  'demo.seeded': 'Demo set up',
  'demo.reset': 'Demo reset',
};

export function eventLabel(t: string): string {
  return EVENT_LABELS[t] ?? t.replace(/[._]/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** The local calendar date of a timestamp, as YYYY-MM-DD (not the UTC date). */
export function localDate(iso: string | Date): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Local midnight of a YYYY-MM-DD date — what AG Grid's date filter compares against. */
export function localMidnight(ymd: string): Date | null {
  const [y, m, d] = ymd.split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
}

/** "Oct 23, 2026, 1:12 AM" in the viewer's time zone — the one format for moments in time. */
export function formatDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/** "Oct 23, 2026" in the viewer's time zone. */
export function formatDate(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { dateStyle: 'medium' });
}
