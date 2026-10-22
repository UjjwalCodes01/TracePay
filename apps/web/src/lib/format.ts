import { formatBps, formatMoney } from '@tracepay/shared';
import type { Economics } from '@tracepay/shared';

export { formatMoney };

export function economicsLabel(e: Economics | null | undefined): string {
  if (!e) return '—';
  if (e.kind === 'percent_of_gross') return `${formatBps(e.bps)} of gross`;
  if (e.kind === 'fixed_per_sale') return `${formatMoney(e.amountCents)} per sale`;
  return 'No payment';
}

export function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export const eventLabel = (t: string) => t.replace(/[._]/g, ' ');

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
