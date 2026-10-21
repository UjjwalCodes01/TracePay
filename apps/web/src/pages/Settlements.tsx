import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import clsx from 'clsx';
import { CheckCheck, RefreshCw, Send } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { RoyaltyLedger } from '../components/RoyaltyLedger';
import { Badge, Button, Card, Empty, ErrorNote, Hash, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { api, post } from '../lib/api';
import { formatMoney } from '../lib/format';
import { gridTheme } from '../lib/grid';
import { useSession } from '../lib/session';
import type { SettlementLine, SettlementRun } from '../lib/types';

type Row = SettlementLine & { recipientName: string; isTotal?: boolean };
/** The API adds each recipient's name to the lines. */
type NamedRun = Omit<SettlementRun, 'lines'> & { lines: Array<SettlementLine & { recipientName?: string | null }> };

/** Each step from what actually happened, not from the overall status (an exception can come at any point). */
const STEPS: Array<{ label: string; done: (r: SettlementRun) => boolean }> = [
  { label: 'Captured & calculated', done: (r) => r.lines.length > 0 && !r.failureReason },
  { label: 'Publisher approved', done: (r) => Boolean(r.approvedAt) },
  { label: 'Payouts submitted', done: (r) => r.batches.some((b) => b.paypalBatchId) },
  { label: 'All payouts succeeded', done: (r) => r.status === 'completed' },
];

/** Why a sale whose payment didn't stand has no more payouts, in plain words. */
const SALE_PROBLEM: Record<string, string> = {
  pending_payment: 'PayPal hasn’t finished taking the buyer’s payment yet',
  payment_failed: 'PayPal didn’t complete the buyer’s payment',
  refunded: 'The buyer’s payment was refunded in PayPal',
  exception: 'The buyer’s payment was partly refunded, reversed or disputed in PayPal',
};

/** A calculation error meant for people, or null when it's a technical message (e.g. JSON). */
function readableReason(reason: string): string | null {
  const t = reason.trim();
  return /^[[{]/.test(t) || t.length > 300 ? null : t;
}

export function SettlementsPage() {
  const qc = useQueryClient();
  const { users } = useSession();
  const q = useQuery({ queryKey: ['settlements'], queryFn: () => api<{ settlements: NamedRun[] }>('/settlements'), refetchInterval: 8000 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const names = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u.name])), [users]);

  const runs = q.data?.settlements ?? [];
  const run = runs.find((r) => r.id === selectedId) ?? runs[0];

  const act = useMutation({
    mutationFn: ({ action, id }: { action: 'approve' | 'payouts' | 'refresh' | 'retry-failed' | 'recalculate'; id: string }) => post(`/settlements/${id}/${action}`),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['settlements'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const columns = useMemo<ColDef<Row>[]>(
    () => [
      {
        headerName: 'Recipient',
        field: 'recipientName',
        flex: 1.6,
        minWidth: 200,
        cellRenderer: (p: ICellRendererParams<Row>) =>
          p.data?.isTotal ? <strong>Total</strong> : (
            <span className="flex items-center gap-2">
              {p.value}
              {p.data?.kind === 'publisher_residual' && <Badge tone="info">merchant</Badge>}
            </span>
          ),
      },
      { headerName: 'License', field: 'licenseGrantId', width: 150, valueFormatter: (p) => p.value ?? '—', cellClass: 'mono' },
      { headerName: 'Calculation', field: 'formula', flex: 1.8, minWidth: 220, cellClass: 'mono', tooltipField: 'note' },
      {
        headerName: 'Amount',
        field: 'amountCents',
        width: 120,
        type: 'rightAligned',
        valueFormatter: (p) => formatMoney(p.value ?? 0),
        cellClass: (p) => clsx('tabular-nums', p.data?.isTotal && 'font-semibold'),
      },
      {
        headerName: 'Payable',
        field: 'payable',
        width: 110,
        cellRenderer: (p: ICellRendererParams<Row>) =>
          p.data?.isTotal ? null : p.value ? <Badge tone="pass">payout</Badge> : <Badge>{p.data?.kind === 'publisher_residual' ? 'retained' : 'not owed'}</Badge>,
      },
      {
        headerName: 'PayPal payout',
        width: 160,
        valueGetter: (p) => p.data?.payoutItem?.status ?? null,
        cellRenderer: (p: ICellRendererParams<Row>) => (p.value ? <StatusBadge status={p.value} /> : p.data?.isTotal ? null : <span className="text-muted">—</span>),
      },
      { headerName: 'Payee', field: 'payeeEmail', flex: 1.2, minWidth: 180, valueFormatter: (p) => p.value ?? '—' },
      { headerName: 'PayPal item', width: 160, valueGetter: (p) => p.data?.payoutItem?.paypalItemId ?? '', cellClass: 'mono' },
    ],
    [],
  );

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  if (!run) {
    return (
      <>
        <PageHeader title="Pay Contributors" />
        <Empty>No settlements yet. A settlement is calculated automatically when a PayPal capture is verified.</Empty>
      </>
    );
  }

  const rows: Row[] = run.lines.map((l) => ({ ...l, recipientName: l.recipientName ?? names[l.recipientId] ?? l.recipientId }));
  const total: Row = {
    id: 'total', kind: 'contributor', recipientId: '', recipientName: 'Total', payeeEmail: null, licenseGrantId: null, assetVersionId: null,
    amountCents: rows.reduce((s, r) => s + r.amountCents, 0), formula: `= verified capture ${formatMoney(run.grossCents)}`, payable: false, note: null, payoutItem: null, isTotal: true,
  };
  const payment = run.sale.payment;
  const latest = run.batches[0];
  const hasFailedPayouts = run.lines.some((l) => l.payoutItem && ['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED'].includes(l.payoutItem.status));

  return (
    <>
      <PageHeader
        title="Pay Contributors"
        subtitle="Each verified PayPal sale is split under the license terms in force at the moment of sale. Nothing is paid until you approve, and a payout only counts as paid when PayPal confirms it."
      />
      <div className="grid gap-6 xl:grid-cols-[280px_minmax(0,1fr)]">
        <Card title="Sales">
          <ul className="-m-2 space-y-1">
            {runs.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => setSelectedId(r.id)}
                  className={clsx('w-full rounded-lg px-3 py-2 text-left text-sm', r.id === run.id ? 'bg-slate-100' : 'hover:bg-slate-50')}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium tabular-nums">{formatMoney(r.grossCents)}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  <div className="truncate text-xs text-muted">{r.sale.artifact.title}</div>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <div className="space-y-6">
          <Card
            title={
              <span className="flex items-center gap-2">
                <Link to={`/reports/${run.sale.artifact.id}`} className="hover:underline">{run.sale.artifact.title}</Link>
                <StatusBadge status={run.status} />
              </span>
            }
            action={
              <div className="flex flex-wrap gap-2">
                {run.status === 'calculated' && (
                  <Button size="sm" loading={act.isPending} onClick={() => act.mutate({ action: 'approve', id: run.id })}>
                    <CheckCheck className="size-4" /> Approve settlement
                  </Button>
                )}
                {(run.status === 'approved' || (run.status === 'payout_submitted' && latest && !latest.paypalBatchId && latest.status !== 'AWAITING_CONFIRMATION')) && (
                  <Button size="sm" loading={act.isPending} onClick={() => act.mutate({ action: 'payouts', id: run.id })}>
                    <Send className="size-4" /> {latest ? 'Try sending again' : 'Send PayPal payouts'}
                  </Button>
                )}
                {run.status === 'exception' && hasFailedPayouts && run.sale.status === 'captured' && (
                  <Button size="sm" loading={act.isPending} onClick={() => act.mutate({ action: 'retry-failed', id: run.id })}>
                    <Send className="size-4" /> Retry failed payouts
                  </Button>
                )}
                {run.status === 'exception' && run.failureReason && run.batches.length === 0 && (
                  <Button size="sm" loading={act.isPending} onClick={() => act.mutate({ action: 'recalculate', id: run.id })}>
                    <RefreshCw className="size-4" /> Recalculate
                  </Button>
                )}
                {latest?.paypalBatchId && (
                  <Button size="sm" variant="secondary" loading={act.isPending} onClick={() => act.mutate({ action: 'refresh', id: run.id })}>
                    <RefreshCw className="size-4" /> Refresh from PayPal
                  </Button>
                )}
              </div>
            }
          >
            <ol className="mb-5 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              {STEPS.map((s, i) => {
                const done = s.done(run);
                return (
                  <li key={s.label} className={clsx('rounded-lg border px-3 py-2', done ? 'border-verified/30 bg-verified-soft text-verified' : 'border-line text-muted')}>
                    {i + 1}. {s.label}
                  </li>
                );
              })}
            </ol>
            {run.status === 'exception' && (
              <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-block">
                {run.sale.status !== 'captured'
                  ? `${SALE_PROBLEM[run.sale.status] ?? 'The buyer’s payment didn’t go through in PayPal'}, so nothing more will be paid out. ${run.batches.some((b) => b.paypalBatchId) ? 'Payouts already sent need to be settled with the contributors under their agreements.' : 'No payouts were sent for this sale.'}`
                  : run.failureReason
                    ? (
                        <>
                          The contributor shares couldn’t be calculated{readableReason(run.failureReason) ? `: ${readableReason(run.failureReason)}` : '.'} Fix the cause (usually a contributor’s missing PayPal email), then recalculate.
                          {!readableReason(run.failureReason) && (
                            <details className="mt-1 text-xs">
                              <summary className="cursor-pointer">Technical details</summary>
                              <pre className="mt-1 whitespace-pre-wrap break-all">{run.failureReason}</pre>
                            </details>
                          )}
                        </>
                      )
                    : latest && ['DENIED', 'CANCELED'].includes(latest.status)
                      ? 'PayPal declined this payout batch. Check your PayPal account, then retry.'
                      : 'Some payouts failed or came back from PayPal. Ask the contributor to check their PayPal email in their profile, then retry the failed payouts.'}
              </div>
            )}
            {latest?.status === 'AWAITING_CONFIRMATION' && (
              <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                PayPal already received these payouts (an earlier response was lost). Nothing was paid twice; the status will update automatically when PayPal confirms.
              </div>
            )}
            <ErrorNote error={act.error} />
            <div className="h-[300px]">
              <AgGridReact<Row>
                theme={gridTheme}
                rowData={rows}
                pinnedBottomRowData={[total]}
                columnDefs={columns}
                defaultColDef={{ resizable: true, sortable: false }}
                tooltipShowDelay={200}
              />
            </div>
            <p className="mt-3 text-xs text-muted">{run.roundingRule}</p>
          </Card>

          <div className="grid gap-6 md:grid-cols-2">
            <Card title="PayPal sale (verified)">
              <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5 text-sm">
                <dt className="text-muted">Order</dt><dd><Hash value={payment?.orderId} n={20} /></dd>
                <dt className="text-muted">Capture</dt><dd><Hash value={payment?.captureId} n={20} /></dd>
                <dt className="text-muted">Capture status</dt><dd>{payment?.captureStatus}</dd>
                <dt className="text-muted">Captured</dt><dd>{payment?.capturedCents != null ? formatMoney(payment.capturedCents) : '—'}</dd>
                <dt className="text-muted">PayPal fee</dt><dd>{payment?.paypalFeeCents != null ? `${formatMoney(payment.paypalFeeCents)} (borne by publisher)` : '—'}</dd>
                <dt className="text-muted">Buyer</dt><dd>{payment?.payerEmail ?? '—'}</dd>
              </dl>
            </Card>
            <Card title={run.batches.length > 1 ? `Payout attempts (${run.batches.length})` : 'Payout batch'}>
              {run.batches.length ? (
                <div className="space-y-4">
                  {run.batches.map((b) => (
                    <dl key={b.attempt} className="grid grid-cols-[8rem_1fr] gap-y-1.5 text-sm">
                      <dt className="text-muted">Attempt</dt><dd>{b.attempt}{b.attempt > 1 && ' (retry of failed payouts)'}</dd>
                      <dt className="text-muted">sender_batch_id</dt><dd><Hash value={b.senderBatchId} n={24} /></dd>
                      <dt className="text-muted">PayPal batch</dt><dd><Hash value={b.paypalBatchId} n={20} /></dd>
                      <dt className="text-muted">Batch status</dt><dd><StatusBadge status={b.status} /></dd>
                      <dt className="text-muted">Last checked</dt><dd>{b.lastCheckedAt ? new Date(b.lastCheckedAt).toLocaleTimeString() : '—'}</dd>
                    </dl>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted">No payout batch yet. The batch id is fixed before submission, so a retry can never pay twice.</p>
              )}
              <p className="mt-3 text-xs text-muted">Terms snapshot <Hash value={run.snapshotHash} /></p>
            </Card>
          </div>
        </div>
      </div>
      <div className="mt-6">
        <RoyaltyLedger runs={runs} names={names} />
      </div>
    </>
  );
}
