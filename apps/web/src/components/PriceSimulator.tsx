import { calculateSettlement, SettlementError, type FrozenTerm } from '@tracepay/shared';
import type { CellValueChangedEvent, ColDef, ICellRendererParams } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import type { AgCartesianChartOptions } from 'ag-charts-community';
import { AgCharts } from 'ag-charts-react';
import { Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { chartTheme, KEPT_COLOR, SERIES_COLORS } from '../lib/charts';
import { formatMoney } from '../lib/format';
import { gridTheme } from '../lib/grid';
import type { CatalogEntry } from '../lib/types';
import { parseDollars } from './DraftInput';
import { Button, Card } from './ui';

interface Scenario {
  id: string;
  priceCents: number;
}

type Row = Scenario & {
  label: string;
  /** Per source: what that contributor is paid at this price. */
  shares: Record<string, number>;
  contributorsCents: number;
  keptCents: number;
  keptPct: number | null;
  problem: string | null;
};

let nextId = 0;
const scenario = (priceCents: number): Scenario => ({ id: `s${++nextId}`, priceCents });

/**
 * "What if I charge $X?" — an editable grid of price scenarios, each settled with the
 * same engine a real sale is settled with (packages/shared), so what you see here is
 * exactly what each contributor would be paid.
 */
export default function PriceSimulator({ sources, priceCents, onUsePrice }: { sources: CatalogEntry[]; priceCents: number; onUsePrice: (cents: number) => void }) {
  // The parent passes a fresh array each render: keep columns stable unless the sources change.
  const key = sources.map((s) => `${s.assetVersionId}:${s.license?.id ?? ''}`).join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const licensed = useMemo(() => sources.filter((s) => s.license), [key]);
  const [scenarios, setScenarios] = useState<Scenario[]>(() => [scenario(Math.max(100, Math.round(priceCents / 200) * 100)), scenario(priceCents), scenario(priceCents * 2)]);
  const [assumeCited, setAssumeCited] = useState(true);

  const rows = useMemo<Row[]>(
    () =>
      scenarios.map((s) => {
        const terms: FrozenTerm[] = licensed.map((src) => ({
          licenseId: src.license!.id,
          assetVersionId: src.assetVersionId,
          assetTitle: src.assetTitle,
          contributorId: src.owner.id,
          payeeEmail: 'simulated@example.com',
          economics: src.license!.terms.economics,
          payableOn: src.license!.terms.payableOn,
          citedInOutput: assumeCited,
        }));
        const base = { ...s, label: formatMoney(s.priceCents), shares: {} as Record<string, number>, contributorsCents: 0, keptCents: 0, keptPct: null as number | null, problem: null as string | null };
        try {
          const r = calculateSettlement({ verifiedGrossCents: s.priceCents, currency: 'USD', publisherId: 'you', terms });
          r.lines.forEach((l) => {
            if (l.kind === 'contributor' && l.assetVersionId) base.shares[l.assetVersionId] = l.amountCents;
          });
          return { ...base, contributorsCents: r.contributorTotalCents, keptCents: r.publisherResidualCents, keptPct: r.publisherResidualCents / r.grossCents };
        } catch (err) {
          if (!(err instanceof SettlementError) && !(err instanceof RangeError)) throw err;
          return { ...base, problem: s.priceCents === 0 ? 'A sale needs a price.' : 'The fixed fees are more than this price, so it can’t be sold.' };
        }
      }),
    [scenarios, licensed, assumeCited],
  );

  const columns = useMemo<ColDef<Row>[]>(
    () => [
      {
        headerName: 'Price',
        field: 'priceCents',
        editable: true,
        width: 110,
        pinned: 'left',
        cellClass: 'tabular-nums font-medium bg-amber-50/60',
        headerTooltip: 'Click a price to change it',
        valueFormatter: (p) => formatMoney(p.value ?? 0),
        valueParser: (p) => {
          const cents = parseDollars(String(p.newValue ?? ''));
          return cents !== null && cents <= 1_000_000 ? cents : p.oldValue;
        },
      },
      ...licensed.map<ColDef<Row>>((src) => ({
        headerName: src.owner.name,
        headerTooltip: `${src.assetTitle}${src.license!.terms.payableOn === 'cited_in_output' ? ' — paid only if cited' : ''}`,
        colId: src.assetVersionId,
        flex: 1,
        minWidth: 140,
        type: 'rightAligned',
        enableCellChangeFlash: true,
        valueGetter: (p) => (p.data?.problem ? null : (p.data?.shares[src.assetVersionId] ?? 0)),
        valueFormatter: (p) => (p.value === null ? '—' : formatMoney(p.value)),
        cellClass: 'tabular-nums',
      })),
      {
        headerName: 'You keep',
        field: 'keptCents',
        width: 120,
        type: 'rightAligned',
        enableCellChangeFlash: true,
        valueFormatter: (p) => (p.data?.problem ? '—' : formatMoney(p.value ?? 0)),
        cellClass: 'tabular-nums font-semibold',
      },
      {
        headerName: 'Share kept',
        field: 'keptPct',
        width: 110,
        type: 'rightAligned',
        valueFormatter: (p) => (p.value === null ? '—' : `${Math.round(p.value * 100)}%`),
        cellClass: 'tabular-nums',
      },
      {
        headerName: '',
        colId: 'actions',
        minWidth: 210,
        flex: 1,
        sortable: false,
        cellRenderer: (p: ICellRendererParams<Row>) =>
          p.data?.problem ? (
            <span className="flex h-full items-center text-xs text-block">{p.data.problem}</span>
          ) : (
            <span className="flex h-full items-center gap-2">
              {p.data!.priceCents === priceCents ? (
                <span className="text-xs text-muted">Current price</span>
              ) : (
                <button type="button" className="text-xs font-medium text-brand hover:underline" onClick={() => onUsePrice(p.data!.priceCents)}>
                  Use this price
                </button>
              )}
              {scenarios.length > 1 && (
                <button type="button" aria-label="Remove this price" className="ml-auto text-muted hover:text-block" onClick={() => setScenarios((all) => all.filter((x) => x.id !== p.data!.id))}>
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </span>
          ),
      },
    ],
    [licensed, priceCents, onUsePrice, scenarios.length],
  );

  const chart = useMemo<AgCartesianChartOptions>(() => {
    const data = rows.filter((r) => !r.problem).map((r) => ({ label: r.label, kept: r.keptCents / 100, ...Object.fromEntries(licensed.map((s) => [s.assetVersionId, (r.shares[s.assetVersionId] ?? 0) / 100])) }));
    const money = (v: number) => formatMoney(Math.round(v * 100));
    return {
      theme: chartTheme,
      data,
      height: 300,
      series: [
        ...licensed.map((s, i) => ({
          type: 'bar' as const,
          xKey: 'label',
          yKey: s.assetVersionId,
          yName: s.owner.name,
          stacked: true,
          fill: SERIES_COLORS[i % SERIES_COLORS.length],
          tooltip: { renderer: ({ datum }: { datum: Record<string, number> }) => ({ title: s.owner.name, content: money(datum[s.assetVersionId] ?? 0) }) },
        })),
        {
          type: 'bar' as const,
          xKey: 'label',
          yKey: 'kept',
          yName: 'You keep',
          stacked: true,
          fill: KEPT_COLOR,
          tooltip: { renderer: ({ datum }: { datum: Record<string, number> }) => ({ title: 'You keep', content: money(datum.kept ?? 0) }) },
        },
      ],
      axes: {
        x: { type: 'category', position: 'bottom', title: { text: 'Price per sale' } },
        y: { type: 'number', position: 'left', label: { formatter: ({ value }: { value: number }) => money(value) } },
      },
      legend: { position: 'bottom' },
    };
  }, [rows, licensed]);

  if (licensed.length === 0) return null;

  return (
    <Card
      title="Price & royalty simulator"
      action={
        <Button size="sm" variant="secondary" onClick={() => setScenarios((all) => [...all, scenario((all.at(-1)?.priceCents ?? priceCents) + 1000)])}>
          <Plus className="size-3.5" /> Add a price
        </Button>
      }
    >
      <p className="mb-3 text-sm text-muted">
        Try prices before you build. Each row is settled with the exact rules a real sale uses, so you see what each contributor is paid and what you keep. Click a price to edit it.
      </p>
      <label className="mb-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={assumeCited} onChange={(e) => setAssumeCited(e.target.checked)} />
        Assume the report cites every source (some licenses pay only when cited)
      </label>
      <div className="h-[220px]">
        <AgGridReact<Row>
          theme={gridTheme}
          rowData={rows}
          getRowId={(p) => p.data.id}
          columnDefs={columns}
          defaultColDef={{ sortable: true, resizable: true }}
          tooltipShowDelay={200}
          singleClickEdit
          stopEditingWhenCellsLoseFocus
          onCellValueChanged={(e: CellValueChangedEvent<Row>) => {
            if (e.colDef.field !== 'priceCents' || !e.data) return;
            const cents = e.newValue as number;
            setScenarios((all) => all.map((x) => (x.id === e.data!.id ? { ...x, priceCents: cents } : x)));
          }}
        />
      </div>
      <div className="mt-4" role="img" aria-label="Who gets what at each price (the table above has the same numbers)">
        <AgCharts options={chart} />
      </div>
    </Card>
  );
}
