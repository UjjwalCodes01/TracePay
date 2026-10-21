import { useQuery } from '@tanstack/react-query';
import { LicenseTermsSchema } from '@tracepay/shared';
import { Link } from 'react-router';
import { Badge, Card, Empty, ErrorNote, Hash, PageHeader, Spinner, Stat, StatusBadge } from '../components/ui';
import { api } from '../lib/api';
import { economicsLabel, formatMoney } from '../lib/format';
import type { PayoutItem } from '../lib/types';

interface EarningLine {
  id: string;
  amountCents: number;
  formula: string;
  payable: boolean;
  note: string | null;
  licenseGrantId: string | null;
  payoutItem: PayoutItem | null;
  run: { status: string; createdAt: string; sale: { id: string; artifact: { id: string; title: string }; payment: { captureId: string | null } | null } };
}

interface License {
  id: string;
  version: number;
  status: string;
  terms: unknown;
  asset: { title: string };
}

/** What PayPal reports for a payout, in plain words. */
const PAYOUT_TEXT: Record<string, { text: string; tone: 'pass' | 'warn' | 'block' | 'neutral' | 'info' }> = {
  SUCCESS: { text: 'Paid', tone: 'pass' },
  PENDING: { text: 'Being sent', tone: 'info' },
  ONHOLD: { text: 'On hold at PayPal', tone: 'warn' },
  UNCLAIMED: { text: 'Waiting for you to claim it in PayPal', tone: 'warn' },
  FAILED: { text: 'Didn’t go through', tone: 'block' },
  RETURNED: { text: 'Returned (not claimed in time)', tone: 'block' },
  BLOCKED: { text: 'Blocked by PayPal', tone: 'block' },
  REFUNDED: { text: 'Taken back', tone: 'block' },
  REVERSED: { text: 'Reversed', tone: 'block' },
  DENIED: { text: 'Declined by PayPal', tone: 'block' },
};

/** Where a settlement stands when no payout has been sent yet. */
const SETTLEMENT_TEXT: Record<string, string> = {
  calculated: 'Waiting for the publisher to approve',
  approved: 'Approved — payout not sent yet',
  payout_submitted: 'Payout being sent',
  completed: 'Settled',
  exception: 'On hold',
};

/** Still to be paid: the settlement is going ahead and PayPal hasn't paid this line yet (mirrors the publisher dashboard). */
const ON_TRACK = ['calculated', 'approved', 'payout_submitted'];

export function EarningsPage() {
  const q = useQuery({ queryKey: ['earnings'], queryFn: () => api<{ lines: EarningLine[]; licenses: License[] }>('/contributor/earnings') });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const { lines, licenses } = q.data!;
  const paid = lines.filter((l) => l.payoutItem?.status === 'SUCCESS').reduce((s, l) => s + l.amountCents, 0);
  // Refunded or disputed sales (an exception) and failed payouts aren't counted as on their way.
  const owed = lines.filter((l) => l.payable && ON_TRACK.includes(l.run.status) && l.payoutItem?.status !== 'SUCCESS').reduce((s, l) => s + l.amountCents, 0);

  return (
    <>
      <PageHeader title="My Earnings" subtitle="Every sale that used your licensed work, the calculation applied, and what PayPal reports for your payout." />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Paid to you" value={formatMoney(paid)} tone="pass" />
        <Stat label="Pending" value={formatMoney(owed)} />
        <Stat label="Sales using your work" value={lines.length} />
      </div>

      <Card title="Settlement records">
        {lines.length === 0 ? (
          <Empty>No sales have used your work yet.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="pb-2 font-medium">Report</th>
                <th className="pb-2 font-medium">PayPal capture</th>
                <th className="pb-2 font-medium">Calculation</th>
                <th className="pb-2 text-right font-medium">Amount</th>
                <th className="pb-2 pl-4 font-medium">Payout</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {lines.map((l) => (
                <tr key={l.id}>
                  <td className="py-2">
                    <div className="font-medium">{l.run.sale.artifact.title}</div>
                    <Link to={`/reports/${l.run.sale.artifact.id}/receipt`} className="text-xs text-brand hover:underline">
                      View receipt
                    </Link>
                  </td>
                  <td className="py-2"><Hash value={l.run.sale.payment?.captureId} n={14} /></td>
                  <td className="py-2">
                    <span className="mono">{l.formula}</span>
                    {l.note && <div className="text-xs text-muted">{l.note}</div>}
                  </td>
                  <td className="py-2 text-right tabular-nums">{formatMoney(l.amountCents)}</td>
                  <td className="py-2 pl-4">
                    {l.payoutItem ? (
                      <Badge tone={PAYOUT_TEXT[l.payoutItem.status]?.tone ?? 'neutral'}>{PAYOUT_TEXT[l.payoutItem.status]?.text ?? l.payoutItem.status}</Badge>
                    ) : (
                      <Badge tone={l.run.status === 'exception' ? 'warn' : 'neutral'}>{l.payable ? (SETTLEMENT_TEXT[l.run.status] ?? l.run.status) : 'Not owed'}</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="My licenses" className="mt-6">
        <ul className="divide-y divide-line text-sm">
          {licenses.map((l) => {
            const t = LicenseTermsSchema.safeParse(l.terms);
            return (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="font-medium">{l.asset.title} <span className="text-xs text-muted">v{l.version}</span></span>
                <span className="flex items-center gap-2">
                  {t.success && <Badge>{economicsLabel(t.data.economics)}</Badge>}
                  <StatusBadge status={l.status} />
                </span>
              </li>
            );
          })}
        </ul>
      </Card>
    </>
  );
}
