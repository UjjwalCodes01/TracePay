import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import clsx from 'clsx';
import { CheckCheck, RefreshCw, Send } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Badge, Button, Card, Empty, ErrorNote, Hash, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { api, post } from '../lib/api';
import { formatMoney } from '../lib/format';
import { gridTheme } from '../lib/grid';
import { useSession } from '../lib/session';
import type { SettlementLine, SettlementRun } from '../lib/types';

type Row = SettlementLine & { recipientName: string; isTotal?: boolean };

const STEPS: Array<{ key: SettlementRun['status'][]; label: string }> = [
  { key: ['calculated', 'approved', 'payout_submitted', 'completed', 'exception'], label: 'Captured & calculated' },
  { key: ['approved', 'payout_submitted', 'completed', 'exception'], label: 'Publisher approved' },
  { key: ['payout_submitted', 'completed', 'exception'], label: 'Payouts submitted' },
  { key: ['completed'], label: 'All payouts succeeded' },
];

export function SettlementsPage() {
  const qc = useQueryClient();
  const { users } = useSession();
  const q = useQuery({ queryKey: ['settlements'], queryFn: () => api<{ settlements: SettlementRun[] }>('/settlements'), refetchInterval: 8000 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const names = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u.name])), [users]);

  const runs = q.data?.settlements ?? [];
  const run = runs.find((r) => r.id === selectedId) ?? runs[0];

  const act = useMutation({
    mutationFn: ({ action, id }: { action: 'approve' | 'payouts' | 'refresh'; id: string }) => post(`/settlements/${id}/${action}`),
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
        <PageHeader title="Settlement Console" />
        <Empty>No settlements yet. A settlement is calculated automatically when a PayPal capture is verified.</Empty>
      </>
    );
  }

  const rows: Row[] = run.lines.map((l) => ({ ...l, recipientName: names[l.recipientId] ?? l.recipientId }));
  const total: Row = {
    id: 'total', kind: 'contributor', recipientId: '', recipientName: 'Total', payeeEmail: null, licenseGrantId: null, assetVersionId: null,
    amountCents: rows.reduce((s, r) => s + r.amountCents, 0), formula: `= verified capture ${formatMoney(run.grossCents)}`, payable: false, note: null, payoutItem: null, isTotal: true,
  };
  const payment = run.sale.payment;

  return (
    <>
      <PageHeader
        title="Settlement Console"
        subtitle="Each verified PayPal sale is split under the license terms frozen when its report was built. Nothing is paid until the publisher approves, and a payout is only 'paid' when PayPal says so."
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
                {(run.status === 'approved' || (run.status === 'payout_submitted' && !run.batch?.paypalBatchId)) && (
                  <Button size="sm" loading={act.isPending} onClick={() => act.mutate({ action: 'payouts', id: run.id })}>
                    <Send className="size-4" /> Send PayPal payouts
                  </Button>
                )}
                {run.batch?.paypalBatchId && (
                  <Button size="sm" variant="secondary" loading={act.isPending} onClick={() => act.mutate({ action: 'refresh', id: run.id })}>
                    <RefreshCw className="size-4" /> Refresh from PayPal
                  </Button>
                )}
              </div>
            }
          >
            <ol className="mb-5 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              {STEPS.map((s, i) => {
                const done = s.key.includes(run.status) && !(run.status === 'exception' && i === 3);
                return (
                  <li key={s.label} className={clsx('rounded-lg border px-3 py-2', done ? 'border-verified/30 bg-verified-soft text-verified' : 'border-line text-muted')}>
                    {i + 1}. {s.label}
                  </li>
                );
              })}
            </ol>
            {run.status === 'exception' && (
              <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-block">
                Exception: a refund, reversal, failed or returned payout was reported by PayPal. This settlement needs reconciliation under the license agreements.
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
            <Card title="Payout batch">
              {run.batch ? (
                <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5 text-sm">
                  <dt className="text-muted">sender_batch_id</dt><dd><Hash value={run.batch.senderBatchId} n={24} /></dd>
                  <dt className="text-muted">PayPal batch</dt><dd><Hash value={run.batch.paypalBatchId} n={20} /></dd>
                  <dt className="text-muted">Batch status</dt><dd><StatusBadge status={run.batch.status} /></dd>
                  <dt className="text-muted">Last checked</dt><dd>{run.batch.lastCheckedAt ? new Date(run.batch.lastCheckedAt).toLocaleTimeString() : '—'}</dd>
                </dl>
              ) : (
                <p className="text-sm text-muted">No payout batch yet. The batch id is fixed before submission, so a retry can never pay twice.</p>
              )}
              <p className="mt-3 text-xs text-muted">Terms snapshot <Hash value={run.snapshotHash} /></p>
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}
