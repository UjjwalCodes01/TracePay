import type { ColDef, GridApi } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import type { AgCartesianChartOptions } from 'ag-charts-community';
import { AgCharts } from 'ag-charts-react';
import { Download, Search } from 'lucide-react';
import { describeFormula } from '@tracepay/shared';
import { useMemo, useState } from 'react';
import { formatMoney, localDate, localMidnight } from '../lib/format';
import { chartTheme, SERIES_COLORS } from '../lib/charts';
import { gridTheme } from '../lib/grid';
import type { SettlementLine, SettlementRun } from '../lib/types';
import { Badge, Button, Card } from './ui';

type LedgerRow = {
  id: string;
  date: string;
  report: string;
  recipient: string;
  role: string;
  formula: string;
  amountCents: number;
  payout: string;
  saleId: string;
  paypalTransaction: string | null;
  isTotal?: boolean;
};

type Run = Omit<SettlementRun, 'lines'> & { lines: Array<SettlementLine & { recipientName?: string | null }> };

/** A payout's PayPal status, in plain words. */
function payoutLabel(line: SettlementLine, run: Run): string {
  if (line.kind === 'publisher_residual') return 'Kept by you';
  if (!line.payable) return 'Not owed';
  const s = line.payoutItem?.status;
  if (!s) return run.status === 'exception' ? 'On hold' : 'Not sent yet';
  if (s === 'SUCCESS') return 'Paid';
  if (s === 'UNCLAIMED') return 'Waiting to be claimed';
  if (['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED'].includes(s)) return 'Failed — retry';
  return 'On its way';
}

const TONE: Record<string, 'pass' | 'warn' | 'block' | 'neutral' | 'info'> = {
  Paid: 'pass',
  'Kept by you': 'info',
  'On its way': 'info',
  'Waiting to be claimed': 'warn',
  'Not sent yet': 'neutral',
  'On hold': 'warn',
  'Failed — retry': 'block',
  'Not owed': 'neutral',
};

/**
 * Every contributor's share of every sale in one place: search it, filter any column,
 * export it for your accountant. Payout cells flash when PayPal reports a change.
 */
export function RoyaltyLedger({ runs, names }: { runs: Run[]; names: Record<string, string> }) {
  const [gridApi, setGridApi] = useState<GridApi<LedgerRow> | null>(null);
  const [search, setSearch] = useState('');
  const [total, setTotal] = useState<LedgerRow | null>(null);
  const [byRecipient, setByRecipient] = useState<Array<{ recipient: string; amount: number }>>([]);

  const rows = useMemo<LedgerRow[]>(
    () =>
      runs.flatMap((run) =>
        run.lines.map((l) => ({
          id: l.id,
          date: localDate(run.createdAt),
          report: run.sale.artifact.title,
          recipient: l.recipientName ?? names[l.recipientId] ?? l.recipientId,
          role: l.kind === 'publisher_residual' ? 'You (publisher)' : 'Contributor',
          formula: l.formula,
          amountCents: l.amountCents,
          payout: payoutLabel(l, run),
          saleId: run.saleId,
          paypalTransaction: l.payoutItem?.transactionId ?? null,
        })),
      ),
    [runs, names],
  );

  const columns = useMemo<ColDef<LedgerRow>[]>(
    () => [
      { headerName: 'Date', field: 'date', width: 150, filter: 'agDateColumnFilter', filterValueGetter: (p) => (p.data ? localMidnight(p.data.date) : null) },
      { headerName: 'Report', field: 'report', flex: 1.4, minWidth: 200, filter: 'agTextColumnFilter' },
      { headerName: 'Recipient', field: 'recipient', flex: 1, minWidth: 160, filter: 'agTextColumnFilter' },
      { headerName: 'Role', field: 'role', width: 150, filter: 'agTextColumnFilter' },
      {
        headerName: 'How it was worked out',
        colId: 'share',
        flex: 1.4,
        minWidth: 220,
        valueGetter: (p) => (p.data && !p.data.isTotal ? describeFormula(p.data.formula) : ''),
        // The exact calculation, as recorded, on hover.
        tooltipValueGetter: (p) => (p.data?.formula ? p.data.formula : undefined),
        filter: 'agTextColumnFilter',
      },
      // Exported with the CSV, not shown.
      { headerName: 'Exact calculation', field: 'formula', hide: true },
      {
        headerName: 'Amount',
        field: 'amountCents',
        width: 130,
        type: 'rightAligned',
        filter: 'agNumberColumnFilter',
        // Filter in dollars, as shown.
        filterValueGetter: (p) => (p.data ? p.data.amountCents / 100 : null),
        valueFormatter: (p) => formatMoney(p.value ?? 0),
        cellClass: (p) => (p.data?.isTotal ? 'tabular-nums font-semibold' : 'tabular-nums'),
      },
      {
        headerName: 'Payout',
        field: 'payout',
        width: 190,
        filter: 'agTextColumnFilter',
        enableCellChangeFlash: true,
        cellRenderer: (p: { value: string; data?: LedgerRow }) => (p.data?.isTotal ? null : <Badge tone={TONE[p.value] ?? 'neutral'}>{p.value}</Badge>),
      },
      { headerName: 'PayPal payout ID', field: 'paypalTransaction', width: 180, cellClass: 'mono', valueFormatter: (p) => (p.data?.isTotal ? '' : (p.value ?? '—')), filter: 'agTextColumnFilter' },
    ],
    [],
  );

  /** The total of what's visible after filtering, pinned under the grid. */
  const recount = (api: GridApi<LedgerRow>) => {
    let cents = 0;
    let n = 0;
    const sums = new Map<string, number>();
    api.forEachNodeAfterFilter((node) => {
      if (!node.data) return;
      cents += node.data.amountCents;
      n++;
      sums.set(node.data.recipient, (sums.get(node.data.recipient) ?? 0) + node.data.amountCents);
    });
    setByRecipient([...sums].map(([recipient, c]) => ({ recipient, amount: c / 100 })).sort((a, b) => b.amount - a.amount));
    setTotal({ id: 'total', date: '', report: `${n} ${n === 1 ? 'share' : 'shares'}`, recipient: '', role: '', formula: '', amountCents: cents, payout: '', saleId: '', paypalTransaction: null, isTotal: true });
  };

  const chart = useMemo<AgCartesianChartOptions>(
    () => ({
      theme: chartTheme,
      data: byRecipient,
      height: Math.max(140, 44 * byRecipient.length + 50),
      // Room for the value label at the end of the longest bar.
      padding: { right: 64 },
      series: [
        {
          type: 'bar',
          direction: 'horizontal',
          xKey: 'recipient',
          yKey: 'amount',
          yName: 'Amount',
          fill: SERIES_COLORS[0],
          label: { enabled: true, placement: 'outside-end', formatter: ({ value }: { value: number }) => formatMoney(Math.round(value * 100)) },
          tooltip: { renderer: ({ datum }: { datum: { recipient: string; amount: number } }) => ({ title: datum.recipient, content: formatMoney(Math.round(datum.amount * 100)) }) },
        },
      ],
      axes: {
        x: { type: 'category', position: 'left' },
        y: { type: 'number', position: 'bottom', label: { formatter: ({ value }: { value: number }) => formatMoney(Math.round(value * 100)) } },
      },
      legend: { enabled: false },
    }),
    [byRecipient],
  );

  if (rows.length === 0) return null;

  return (
    <Card
      title="Contributors’ shares — every sale"
      action={
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
            <input
              aria-label="Search contributors’ shares"
              placeholder="Search…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                gridApi?.setGridOption('quickFilterText', e.target.value);
              }}
              className="h-8 w-44 rounded-lg border border-line pl-8 pr-2 text-sm"
            />
          </label>
          <Button
            size="sm"
            variant="secondary"
            disabled={!gridApi}
            onClick={() => gridApi?.exportDataAsCsv({ fileName: `tracepay-royalties-${localDate(new Date())}.csv`, skipPinnedBottom: false, allColumns: true })}
          >
            <Download className="size-3.5" /> Export CSV
          </Button>
        </div>
      }
    >
      <p className="mb-3 text-sm text-muted">Who was owed what from each sale, and whether PayPal has paid it. Filter any column; the total follows your filters. Hover a share to see the exact calculation.</p>
      <div className="h-[420px]">
        <AgGridReact<LedgerRow>
          theme={gridTheme}
          rowData={rows}
          getRowId={(p) => p.data.id}
          columnDefs={columns}
          defaultColDef={{ sortable: true, resizable: true, floatingFilter: true }}
          tooltipShowDelay={200}
          pinnedBottomRowData={total ? [total] : []}
          onGridReady={(e) => {
            setGridApi(e.api);
            recount(e.api);
          }}
          onFilterChanged={(e) => recount(e.api)}
          onRowDataUpdated={(e) => recount(e.api)}
        />
      </div>
      {byRecipient.length > 0 && (
        <div className="mt-5" role="img" aria-label="Total per recipient for the rows shown above">
          <div className="mb-1 text-sm font-medium">Total per recipient{search || byRecipient.length < new Set(rows.map((r) => r.recipient)).size ? ' (filtered)' : ''}</div>
          <AgCharts options={chart} />
        </div>
      )}
    </Card>
  );
}
