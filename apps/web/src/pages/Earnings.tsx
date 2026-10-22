import { useQuery } from '@tanstack/react-query';
import { LicenseTermsSchema } from '@tracepay/shared';
import { lazy, Suspense } from 'react';
import { Badge, Card, Empty, ErrorNote, PageHeader, Spinner, Stat, StatusBadge, statusLabel } from '../components/ui';
import { api } from '../lib/api';
import { economicsLabel, formatMoney, localDate } from '../lib/format';
import type { PayoutItem } from '../lib/types';

// AG Grid loads only on this page.
const EarningsGrid = lazy(() => import('../components/EarningsGrid'));

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

/** Where the payment split stands when no payout has been sent yet. */
const SETTLEMENT_TEXT: Record<string, string> = {
  calculated: 'Waiting for the publisher to approve',
  approved: 'Approved — payout not sent yet',
  payout_submitted: 'Payout being sent',
  completed: 'Done',
  exception: 'On hold',
};

/** Still to be paid: the payment split is going ahead and PayPal hasn't paid this share yet (mirrors the publisher dashboard). */
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
      <PageHeader title="My earnings" subtitle="Every sale and AI answer that used your licensed work, how your share was worked out, and where your PayPal payout stands." />
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Paid to you" value={formatMoney(paid)} tone="pass" />
        <Stat label="Owed to you" value={formatMoney(owed)} />
        <Stat label="Sales using your work" value={lines.length} />
      </div>

      <Card title="Your share of every sale">
        {lines.length === 0 ? (
          <Empty>No sales have used your work yet. When a publisher sells a report that uses your sources, your share shows up here.</Empty>
        ) : (
          <Suspense fallback={<Spinner />}>
            <EarningsGrid
              rows={lines.map((l) => ({
                id: l.id,
                date: localDate(l.run.createdAt),
                reportId: l.run.sale.artifact.id,
                report: l.run.sale.artifact.title,
                formula: l.formula,
                note: l.note,
                amountCents: l.amountCents,
                status: l.payoutItem
                  ? (PAYOUT_TEXT[l.payoutItem.status] ?? { text: statusLabel(l.payoutItem.status), tone: 'neutral' })
                  : { text: l.payable ? (SETTLEMENT_TEXT[l.run.status] ?? statusLabel(l.run.status)) : 'Not owed', tone: l.run.status === 'exception' ? 'warn' : 'neutral' },
                captureId: l.run.sale.payment?.captureId ?? null,
                paypalTransaction: l.payoutItem?.transactionId ?? null,
              }))}
            />
          </Suspense>
        )}
      </Card>

      <AnswerEarnings />

      <Card title="My licenses" className="mt-6">
        <ul className="divide-y divide-line text-sm">
          {licenses.map((l) => {
            const t = LicenseTermsSchema.safeParse(l.terms);
            return (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="font-medium">{l.asset.title} <span className="text-xs text-muted">version {l.version}</span></span>
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

interface AnswerEarningsData {
  paidCents: number;
  owedCents: number;
  citations: number;
  credits: Array<{ id: string; createdAt: string; library: string; assetTitle: string; citations: number; centsPerCitation: number; amountCents: number; status: 'accrued' | 'in_payout' | 'paid'; payoutStatus: string | null }>;
}

const CREDIT_TEXT: Record<AnswerEarningsData['credits'][number]['status'], { text: string; tone: 'pass' | 'info' | 'neutral' }> = {
  accrued: { text: 'Earned — paid in the next payout', tone: 'neutral' },
  in_payout: { text: 'On its way via PayPal', tone: 'info' },
  paid: { text: 'Paid', tone: 'pass' },
};

/** Pay-per-citation: what AI answers that relied on your work have earned you. */
function AnswerEarnings() {
  const q = useQuery({ queryKey: ['answer-earnings'], queryFn: () => api<AnswerEarningsData>('/contributor/answer-earnings') });
  if (q.isLoading) {
    return (
      <Card title="From AI answers — paid per cited passage" className="mt-6">
        <Spinner />
      </Card>
    );
  }
  if (q.error || !q.data) {
    return (
      <Card title="From AI answers — paid per cited passage" className="mt-6">
        <ErrorNote error={q.error ?? new Error('Your AI answer earnings couldn’t be loaded.')} />
      </Card>
    );
  }
  const d = q.data;
  return (
    <Card title="From AI answers — paid per cited passage" className="mt-6">
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Paid to you" value={formatMoney(d.paidCents)} tone="pass" />
        <Stat label="Owed to you" value={formatMoney(d.owedCents)} />
        <Stat label="Passages cited" value={d.citations} />
      </div>
      {d.credits.length === 0 ? (
        <Empty>No AI answer has cited your work yet. Allow AI answers in your license terms to start earning each time an answer cites you.</Empty>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {d.credits.slice(0, 15).map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <span className="font-medium">{c.assetTitle}</span>
                <span className="text-muted"> · {c.citations} passage{c.citations === 1 ? '' : 's'} × {formatMoney(c.centsPerCitation)} · {c.library}</span>
              </span>
              <span className="flex items-center gap-2">
                <Badge tone={CREDIT_TEXT[c.status].tone}>{CREDIT_TEXT[c.status].text}</Badge>
                <span className="w-14 text-right font-medium tabular-nums">{formatMoney(c.amountCents)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
