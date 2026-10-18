import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router';
import { Card, ErrorNote, Hash, PageHeader, Spinner, Stat } from '../components/ui';
import { api } from '../lib/api';
import { eventLabel, formatMoney, timeAgo } from '../lib/format';
import type { Dashboard } from '../lib/types';

export function DashboardPage() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Dashboard>('/dashboard'), refetchInterval: 5000 });
  const chain = useQuery({ queryKey: ['chain'], queryFn: () => api<{ ok: boolean; length?: number }>('/audit/verify-chain'), refetchInterval: 10000 });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const d = q.data!;

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Every AI-generated report passes a license preflight before it is built, and every sale settles to contributors under the terms that were approved for it."
        action={
          <Link to="/studio" className="inline-flex h-10 items-center gap-2 rounded-lg bg-ink px-4 text-sm font-medium text-white hover:bg-slate-800">
            New build <ArrowRight className="size-4" />
          </Link>
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Builds passed" value={d.buildsPassed} hint={`${d.artifacts} reports generated`} tone="pass" />
        <Stat label="Builds blocked" value={d.buildsBlocked} hint="Stopped by the license compiler" tone={d.buildsBlocked ? 'block' : undefined} />
        <Stat label="Verified sales" value={formatMoney(d.verifiedSalesCents)} hint={`${d.verifiedSales} PayPal captures`} />
        <Stat label="Exceptions" value={d.exceptions} hint="Refunds, failed or returned payouts" tone={d.exceptions ? 'block' : undefined} />
        <Stat label="Owed to contributors" value={formatMoney(d.unsettledContributorCents)} hint="Calculated, not yet paid" />
        <Stat label="Paid to contributors" value={formatMoney(d.paidOutCents)} hint={`${d.payoutsCompleted} PayPal payouts succeeded`} tone="pass" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title="Audit trail"
          action={
            chain.data && (
              <span className={`flex items-center gap-1 text-xs ${chain.data.ok ? 'text-pass' : 'text-block'}`}>
                <ShieldCheck className="size-3.5" />
                {chain.data.ok ? `Hash chain intact (${chain.data.length} events)` : 'Hash chain BROKEN'}
              </span>
            )
          }
        >
          {d.recentEvents.length === 0 ? (
            <p className="text-sm text-muted">No events yet.</p>
          ) : (
            <ol className="divide-y divide-line">
              {d.recentEvents.map((e) => (
                <li key={e.seq} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="mono w-8 shrink-0 text-muted">#{e.seq}</span>
                    <span className="truncate font-medium capitalize">{eventLabel(e.eventType)}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-xs text-muted">
                    <Hash value={e.hash} n={8} />
                    <span className="w-16 text-right">{timeAgo(e.createdAt)}</span>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Card>
        <Card title="How TracePay decides">
          <ol className="space-y-3 text-sm">
            {[
              ['Preflight', 'Deterministic rules check every source license against the intended sale.'],
              ['Generate', 'The model may only cite passages retrieved from approved sources.'],
              ['Sell', 'PayPal Checkout; the server captures and verifies the payment.'],
              ['Settle', 'Frozen terms, integer cents, publisher approval.'],
              ['Pay', 'PayPal Payouts; statuses read back from PayPal.'],
            ].map(([t, d], i) => (
              <li key={t} className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold">{i + 1}</span>
                <div>
                  <div className="font-medium">{t}</div>
                  <div className="text-muted">{d}</div>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}
