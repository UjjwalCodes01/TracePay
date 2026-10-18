import { useQuery } from '@tanstack/react-query';
import { LicenseTermsSchema } from '@tracepay/shared';
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

export function EarningsPage() {
  const q = useQuery({ queryKey: ['earnings'], queryFn: () => api<{ lines: EarningLine[]; licenses: License[] }>('/contributor/earnings') });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const { lines, licenses } = q.data!;
  const paid = lines.filter((l) => l.payoutItem?.status === 'SUCCESS').reduce((s, l) => s + l.amountCents, 0);
  const owed = lines.filter((l) => l.payable && l.payoutItem?.status !== 'SUCCESS').reduce((s, l) => s + l.amountCents, 0);

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
                  <td className="py-2 font-medium">{l.run.sale.artifact.title}</td>
                  <td className="py-2"><Hash value={l.run.sale.payment?.captureId} n={14} /></td>
                  <td className="py-2">
                    <span className="mono">{l.formula}</span>
                    {l.note && <div className="text-xs text-muted">{l.note}</div>}
                  </td>
                  <td className="py-2 text-right tabular-nums">{formatMoney(l.amountCents)}</td>
                  <td className="py-2 pl-4">{l.payoutItem ? <StatusBadge status={l.payoutItem.status} /> : <Badge>{l.payable ? `settlement ${l.run.status.replace('_', ' ')}` : 'not owed'}</Badge>}</td>
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
