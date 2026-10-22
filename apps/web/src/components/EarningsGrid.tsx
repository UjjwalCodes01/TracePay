import type { ColDef, GridApi, ICellRendererParams } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { Download, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { formatMoney } from '../lib/format';
import { gridTheme } from '../lib/grid';
import { Badge, Button } from './ui';

export interface EarningRow {
  id: string;
  date: string;
  reportId: string;
  report: string;
  formula: string;
  note: string | null;
  amountCents: number;
  status: { text: string; tone: 'pass' | 'warn' | 'block' | 'neutral' | 'info' };
  captureId: string | null;
  paypalTransaction: string | null;
}

/** A contributor's settlement records: search, filter, and export them (e.g. for taxes). */
export default function EarningsGrid({ rows }: { rows: EarningRow[] }) {
  const [gridApi, setGridApi] = useState<GridApi<EarningRow> | null>(null);
  const [search, setSearch] = useState('');
  const columns = useMemo<ColDef<EarningRow>[]>(
    () => [
      { headerName: 'Date', field: 'date', width: 150, filter: 'agDateColumnFilter', filterValueGetter: (p) => (p.data ? new Date(p.data.date) : null) },
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
      { headerName: 'Calculation', field: 'formula', flex: 1.2, minWidth: 190, cellClass: 'mono', tooltipField: 'note', filter: 'agTextColumnFilter' },
      {
        headerName: 'Amount',
        field: 'amountCents',
        width: 120,
        type: 'rightAligned',
        filter: 'agNumberColumnFilter',
        filterValueGetter: (p) => (p.data ? p.data.amountCents / 100 : null),
        valueFormatter: (p) => formatMoney(p.value ?? 0),
        cellClass: 'tabular-nums',
      },
      {
        headerName: 'Payout',
        colId: 'status',
        width: 230,
        filter: 'agTextColumnFilter',
        valueGetter: (p) => p.data?.status.text,
        enableCellChangeFlash: true,
        cellRenderer: (p: ICellRendererParams<EarningRow>) => <Badge tone={p.data!.status.tone}>{p.value}</Badge>,
      },
      { headerName: 'PayPal capture', field: 'captureId', width: 170, cellClass: 'mono', valueFormatter: (p) => p.value ?? '—' },
      { headerName: 'PayPal transaction', field: 'paypalTransaction', width: 170, cellClass: 'mono', valueFormatter: (p) => p.value ?? '—' },
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
        <Button size="sm" variant="secondary" disabled={!gridApi} onClick={() => gridApi?.exportDataAsCsv({ fileName: `tracepay-earnings-${new Date().toISOString().slice(0, 10)}.csv` })}>
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
          defaultColDef={{ sortable: true, resizable: true, floatingFilter: true }}
          tooltipShowDelay={200}
          onGridReady={(e) => setGridApi(e.api)}
        />
      </div>
    </>
  );
}
