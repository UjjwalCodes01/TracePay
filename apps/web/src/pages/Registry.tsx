import { useQuery } from '@tanstack/react-query';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { formatDay } from '@tracepay/shared';
import clsx from 'clsx';
import { Badge, Card, Empty, ErrorNote, Hash, PageHeader, Spinner, StatusBadge, TechnicalDetails } from '../components/ui';
import { FindSourcesPanel, KIND_LABEL, OffersPanel } from './PublisherLicensing';
import { TermsSummary } from '../components/Terms';
import { api } from '../lib/api';
import { economicsLabel } from '../lib/format';
import { useSession } from '../lib/session';
import { gridTheme } from '../lib/grid';
import type { CatalogEntry } from '../lib/types';

const yesNo = (v: boolean | undefined, yes = 'Allowed', no = 'Not allowed') =>
  v === undefined ? <span className="text-muted">—</span> : <Badge tone={v ? 'pass' : 'block'}>{v ? yes : no}</Badge>;

/** Where a source's license stands today, as a status key `statusLabel` knows. */
function licenseState(a: CatalogEntry, today: string): string {
  const l = a.license;
  if (!l) return a.pending?.status ?? 'not_started';
  return l.terms.validUntil && l.terms.validUntil < today ? 'expired' : l.status;
}

const LicenseBadge = ({ state }: { state: string }) => (state === 'expired' ? <Badge tone="block">Expired</Badge> : <StatusBadge status={state} />);

const DEFAULT_COL: ColDef = { sortable: true, resizable: true };

export function RegistryPage() {
  const { user } = useSession();
  // Reviewing offers and requesting sources are things a publisher does (the API refuses admins).
  const isPublisher = user?.role === 'publisher';
  const q = useQuery({ queryKey: ['catalog'], queryFn: () => api<{ assets: CatalogEntry[] }>('/catalog') });
  const inbox = useQuery({ queryKey: ['license-inbox'], queryFn: () => api<{ licenses: Array<{ status: string }> }>('/licenses/inbox'), enabled: isPublisher });
  const [params, setParams] = useSearchParams();
  const asked = (params.get('tab') ?? 'licenses') as 'licenses' | 'offers' | 'find';
  const tab = isPublisher ? asked : 'licenses';
  // The id, not a copy of the row: a refetch then shows the fresh row, and a removed one closes its card.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);

  // A stable array (new only when the data changes), with stable row ids: re-renders don't reset the grid's selection.
  const rows = useMemo(() => (q.data?.assets ?? []).filter((a) => a.license || a.pending), [q.data]);
  const selected = rows.find((a) => a.assetVersionId === selectedId) ?? null;

  const columns = useMemo<ColDef<CatalogEntry>[]>(
    () => [
      { headerName: 'Source', field: 'assetTitle', flex: 2, minWidth: 220, cellClass: 'font-medium', tooltip: (p) => p.data?.assetTitle },
      { headerName: 'Contributor', colId: 'owner', valueGetter: (p) => p.data?.owner.name, flex: 1.3, minWidth: 160, tooltip: (p) => p.value },
      {
        headerName: 'License',
        colId: 'license',
        flex: 0.8,
        minWidth: 130,
        valueGetter: (p) => (p.data ? licenseState(p.data, today) : null),
        cellRenderer: (p: ICellRendererParams) => (p.value ? <LicenseBadge state={p.value} /> : null),
      },
      {
        headerName: 'May be sold',
        colId: 'commercial',
        flex: 0.7,
        minWidth: 120,
        headerTooltip: 'May it be used in reports that are sold?',
        valueGetter: (p) => p.data?.license?.terms.commercialUse,
        cellRenderer: (p: ICellRendererParams) => yesNo(p.value, 'Yes', 'No'),
      },
      { headerName: 'Contributor’s share', colId: 'share', flex: 1, minWidth: 150, valueGetter: (p) => economicsLabel(p.data?.license?.terms.economics) },
      {
        headerName: 'Valid until',
        colId: 'validUntil',
        flex: 0.9,
        minWidth: 140,
        valueGetter: (p) => p.data?.license?.terms.validUntil ?? null,
        valueFormatter: (p) => (p.data?.license ? (p.value ? formatDay(String(p.value)) : 'No end date') : '—'),
      },
    ],
    [today],
  );

  if (q.error && !q.data) return <ErrorNote error={q.error} />;
  if (!q.data) return <Spinner />;
  const offersWaiting = inbox.data?.licenses.filter((l) => l.status === 'offered').length ?? 0;
  const tabs = [
    { key: 'licenses', label: 'My licenses' },
    ...(isPublisher
      ? ([
          { key: 'offers', label: `Offers to review${offersWaiting ? ` (${offersWaiting})` : ''}` },
          { key: 'find', label: 'Find sources' },
        ] as const)
      : []),
  ] as const;

  return (
    <>
      <PageHeader
        title="Sources & licenses"
        subtitle="The sources you’re licensed to use, offers waiting for your decision, and new sources you can request."
      />
      {tabs.length > 1 && (
        <div className="mb-5 flex max-w-full overflow-x-auto">
          <div className="inline-flex shrink-0 rounded-lg border border-line bg-white p-1 text-sm">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                aria-pressed={tab === t.key}
                onClick={() => setParams({ tab: t.key })}
                className={clsx(
                  'whitespace-nowrap rounded-md px-3 py-1.5',
                  tab === t.key ? 'bg-ink text-white' : 'text-muted hover:text-ink',
                  t.key === 'offers' && offersWaiting > 0 && tab !== 'offers' && 'font-semibold text-contract',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {tab === 'offers' && <OffersPanel />}
      {tab === 'find' && <FindSourcesPanel />}
      {tab === 'licenses' && (
      <>
      {rows.length === 0 ? (
        <Empty>
          No licensed sources yet.{isPublisher ? ' Open “Find sources” to request a license from a contributor; once they offer terms and you accept, the source shows here.' : ''}
        </Empty>
      ) : (
        <>
          {/* Phones: one card per source. Wider screens: the grid. */}
          <ul className="space-y-2 md:hidden">
            {rows.map((a) => (
              <li key={a.assetVersionId}>
                <button
                  type="button"
                  aria-pressed={selectedId === a.assetVersionId}
                  onClick={() => setSelectedId(selectedId === a.assetVersionId ? null : a.assetVersionId)}
                  className={clsx('w-full rounded-xl border bg-white p-4 text-left', selectedId === a.assetVersionId ? 'border-ink' : 'border-line')}
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="min-w-0 font-medium">{a.assetTitle}</span>
                    <LicenseBadge state={licenseState(a, today)} />
                  </span>
                  <span className="mt-1 block text-xs text-muted">{a.owner.name}</span>
                  {a.license && (
                    <span className="mt-2 flex flex-wrap gap-1 text-xs">
                      <Badge tone={a.license.terms.commercialUse ? 'pass' : 'block'}>{a.license.terms.commercialUse ? 'Can be sold' : 'Internal research only'}</Badge>
                      <Badge>{economicsLabel(a.license.terms.economics)}</Badge>
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <div className="hidden md:block">
            <AgGridReact<CatalogEntry>
              domLayout="autoHeight"
              theme={gridTheme}
              rowData={rows}
              getRowId={(p) => p.data.assetVersionId}
              columnDefs={columns}
              rowSelection={{ mode: 'singleRow', checkboxes: false, enableClickSelection: true }}
              onSelectionChanged={(e) => {
                // Only the visitor's own clicks: a data refresh must not close the details card.
                if (e.source === 'rowDataChanged' || e.source === 'gridInitializing') return;
                setSelectedId(e.api.getSelectedRows()[0]?.assetVersionId ?? null);
              }}
              tooltipShowDelay={300}
              defaultColDef={DEFAULT_COL}
            />
            <p className="mt-2 text-xs text-muted">Select a source to see everything its license allows.</p>
          </div>
        </>
      )}

      {selected && (
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Card title={selected.assetTitle}>
            <p className="text-sm text-muted">{selected.description}</p>
            <dl className="mt-4 grid grid-cols-[9rem_minmax(0,1fr)] gap-y-2 text-sm">
              <dt className="text-muted">License</dt>
              <dd><LicenseBadge state={licenseState(selected, today)} /></dd>
              <dt className="text-muted">Type</dt>
              <dd>{KIND_LABEL[selected.kind] ?? selected.kind.replace(/_/g, ' ')}</dd>
              <dt className="text-muted">Contributor</dt>
              <dd>{selected.owner.name}</dd>
              <dt className="text-muted">Version</dt>
              <dd>Version {selected.version}</dd>
              <dt className="text-muted">Passages</dt>
              <dd>{selected.chunkCount} passages a report can draw on</dd>
              {selected.license && (
                <>
                  <dt className="text-muted">License version</dt>
                  <dd>Version {selected.license.version}</dd>
                </>
              )}
              {selected.license?.terms.attributionText && (
                <>
                  <dt className="text-muted">Credit line</dt>
                  <dd>“{selected.license.terms.attributionText}”</dd>
                </>
              )}
            </dl>
            <TechnicalDetails>
              <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-y-2">
                <dt className="text-muted">Source version ID</dt>
                <dd>
                  <Hash value={selected.assetVersionId} n={32} />
                </dd>
                <dt className="text-muted">Content fingerprint (SHA-256)</dt>
                <dd>
                  <Hash value={selected.sha256} n={24} />
                </dd>
                <dt className="text-muted">License ID</dt>
                <dd>
                  <Hash value={selected.license?.id} n={32} />
                </dd>
                <dt className="text-muted">Terms fingerprint</dt>
                <dd>
                  <Hash value={selected.license?.termsHash} n={24} />
                </dd>
              </dl>
            </TechnicalDetails>
          </Card>
          <Card title="What you're allowed to do">
            {selected.license ? <TermsSummary terms={selected.license.terms} /> : <p className="text-sm text-muted">No license in force yet. Once the contributor offers terms and you accept them, they show here.</p>}
            {selected.license?.sourceText && (
              <details className="mt-4 text-sm">
                <summary className="cursor-pointer text-muted">Original license text</summary>
                <blockquote className="mt-2 border-l-2 border-line pl-3 text-slate-700">{selected.license.sourceText}</blockquote>
              </details>
            )}
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer text-muted">Terms as stored (technical)</summary>
              <pre className="mono mt-2 max-h-64 overflow-auto rounded-lg bg-slate-50 p-3 text-slate-700">{JSON.stringify(selected.license?.terms, null, 2)}</pre>
            </details>
          </Card>
        </div>
      )}
      </>
      )}
    </>
  );
}
