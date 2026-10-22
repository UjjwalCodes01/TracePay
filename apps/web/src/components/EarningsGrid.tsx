import type { ColDef, GridApi, ICellRendererParams } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { Download, Search } from 'lucide-react';
import { describeFormula } from '@tracepay/shared';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { formatMoney, localDate, localMidnight } from '../lib/format';
import { gridTheme } from '../lib/grid';
import { Badge, Button, type statusTone } from './ui';

export interface EarningRow {
  id: string;
  date: string;
  reportId: string;
  report: string;
  formula: string;
  note: string | null;
  amountCents: number;
  status: { text: string; tone: ReturnType<typeof statusTone> };
  captureId: string | null;
  paypalTransaction: string | null;
}

const DEFAULT_COL: ColDef<EarningRow> = { sortable: true, resizable: true, floatingFilter: true };

/** A contributor's share of every sale: search, filter, and export them (e.g. for taxes). */
export default function EarningsGrid({ rows }: { rows: EarningRow[] }) {
  const [gridApi, setGridApi] = useState<GridApi<EarningRow> | null>(null);
  const [search, setSearch] = useState('');
  const columns = useMemo<ColDef<EarningRow>[]>(
    () => [
      { headerName: 'Date', field: 'date', width: 175, minWidth: 175, filter: 'agDateColumnFilter', filterValueGetter: (p) => (p.data ? localMidnight(p.data.date) : null) },
      {
        headerName: 'Report',
        field: 'report',
        flex: 1.4,
        minWidth: 200,
        filter: 'agTextColumnFilter',
      },
      {
        headerName: 'Receipt',
        colId: 'receipt',
        width: 100,
        sortable: false,
        cellRenderer: (p: ICellRendererParams<EarningRow>) => (
          <Link to={`/reports/${p.data!.reportId}/receipt`} className="text-brand hover:underline">
            View
          </Link>
        ),
      },
      {
        headerName: 'Your share',
        colId: 'share',
        flex: 1.2,
        minWidth: 190,
        valueGetter: (p) => (p.data ? describeFormula(p.data.formula) : ''),
        // The exact calculation, as recorded, on hover.
        tooltip: (p) => (p.data ? [p.data.formula, p.data.note].filter(Boolean).join(' — ') : undefined),
        filter: 'agTextColumnFilter',
      },
      // Exported with the CSV, not shown.
      { headerName: 'Exact calculation', field: 'formula', hide: true },
      {
        headerName: 'Amount',
        field: 'amountCents',
        width: 110,
        // Pinned, so what you earned stays on screen on a phone.
        pinned: 'right',
        type: 'rightAligned',
        filter: 'agNumberColumnFilter',
        filterValueGetter: (p) => (p.data ? p.data.amountCents / 100 : null),
        valueFormatter: (p) => formatMoney(p.value ?? 0),
        cellClass: 'tabular-nums',
      },
      {
        headerName: 'Payout',
        colId: 'status',
        width: 270,
        minWidth: 270,
        filter: 'agTextColumnFilter',
        valueGetter: (p) => p.data?.status.text,
        tooltip: (p) => p.value,
        enableCellChangeFlash: true,
        cellRenderer: (p: ICellRendererParams<EarningRow>) => <Badge tone={p.data!.status.tone}>{p.value}</Badge>,
      },
      { headerName: 'PayPal payment ID', field: 'captureId', width: 170, cellClass: 'mono', valueFormatter: (p) => p.value ?? '—', headerTooltip: 'The buyer’s payment, as PayPal records it' },
      { headerName: 'PayPal payout ID', field: 'paypalTransaction', width: 170, cellClass: 'mono', valueFormatter: (p) => p.value ?? '—', headerTooltip: 'Your payout, as PayPal records it' },
    ],
    [],
  );

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
        <label className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
          <input
            aria-label="Search your earnings"
            placeholder="Search…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              gridApi?.setGridOption('quickFilterText', e.target.value);
            }}
            className="h-8 w-44 rounded-lg border border-line pl-8 pr-2 text-sm"
          />
        </label>
        <Button size="sm" variant="secondary" disabled={!gridApi} onClick={() => gridApi?.exportDataAsCsv({ fileName: `tracepay-earnings-${localDate(new Date())}.csv`, allColumns: true })}>
          <Download className="size-3.5" /> Export CSV
        </Button>
      </div>
      <div className={rows.length > 8 ? 'h-[420px]' : undefined}>
        <AgGridReact<EarningRow>
          theme={gridTheme}
          domLayout={rows.length > 8 ? 'normal' : 'autoHeight'}
          rowData={rows}
          getRowId={(p) => p.data.id}
          columnDefs={columns}
          defaultColDef={DEFAULT_COL}
          tooltipShowDelay={200}
          onGridReady={(e) => setGridApi(e.api)}
        />
      </div>
    </>
  );
}
