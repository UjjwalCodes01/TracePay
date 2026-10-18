import { useQuery } from '@tanstack/react-query';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Badge, Card, ErrorNote, Hash, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { FindSourcesPanel, OffersPanel } from './PublisherLicensing';
import { TermsSummary } from '../components/Terms';
import { api } from '../lib/api';
import { economicsLabel } from '../lib/format';
import { gridTheme } from '../lib/grid';
import type { CatalogEntry } from '../lib/types';

const yesNo = (v: boolean | undefined, yes = 'Allowed', no = 'Prohibited') =>
  v === undefined ? <span className="text-muted">—</span> : <Badge tone={v ? 'pass' : 'block'}>{v ? yes : no}</Badge>;

export function RegistryPage() {
  const q = useQuery({ queryKey: ['catalog'], queryFn: () => api<{ assets: CatalogEntry[] }>('/catalog') });
  const inbox = useQuery({ queryKey: ['license-inbox'], queryFn: () => api<{ licenses: Array<{ status: string }> }>('/licenses/inbox') });
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') ?? 'licenses') as 'licenses' | 'offers' | 'find';
  const [selected, setSelected] = useState<CatalogEntry | null>(null);
  const today = new Date().toISOString().slice(0, 10);

  const columns = useMemo<ColDef<CatalogEntry>[]>(
    () => [
      { headerName: 'Asset', field: 'assetTitle', pinned: 'left', width: 300, cellClass: 'font-medium', tooltipField: 'assetTitle' },
      { headerName: 'Owner', valueGetter: (p) => p.data?.owner.name, flex: 1.4, minWidth: 160 },
      { headerName: 'Kind', field: 'kind', width: 130, valueFormatter: (p) => String(p.value).replace('_', ' ') },
      {
        headerName: 'License',
        width: 120,
        valueGetter: (p) => {
          const l = p.data?.license;
          if (!l) return 'none';
          return l.terms.validUntil && l.terms.validUntil < today ? 'expired' : l.status;
        },
        cellRenderer: (p: ICellRendererParams) => (p.value === 'expired' ? <Badge tone="block">expired</Badge> : <StatusBadge status={p.value} />),
      },
      {
        headerName: 'Commercial use',
        width: 140,
        valueGetter: (p) => p.data?.license?.terms.commercialUse,
        cellRenderer: (p: ICellRendererParams) => yesNo(p.value),
      },
      {
        headerName: 'Purposes',
        width: 210,
        valueGetter: (p) => p.data?.license?.terms.allowedPurposes.join(', ').replace(/_/g, ' '),
      },
      {
        headerName: 'Derivative reports',
        width: 170,
        valueGetter: (p) => p.data?.license?.terms.derivativeReports.replace(/_/g, ' '),
      },
      {
        headerName: 'Raw redistribution',
        width: 160,
        valueGetter: (p) => p.data?.license?.terms.rawRedistribution,
        cellRenderer: (p: ICellRendererParams) => yesNo(p.value),
      },
      { headerName: 'Royalty', width: 150, valueGetter: (p) => economicsLabel(p.data?.license?.terms.economics) },
      {
        headerName: 'Payable when',
        width: 150,
        valueGetter: (p) => (p.data?.license?.terms.payableOn === 'cited_in_output' ? 'cited in output' : 'included in build'),
      },
      { headerName: 'Valid until', width: 120, valueGetter: (p) => p.data?.license?.terms.validUntil ?? 'open-ended' },
    ],
    [today],
  );

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const offersWaiting = inbox.data?.licenses.filter((l) => l.status === 'offered').length ?? 0;
  const tabs = [
    { key: 'licenses', label: 'My licenses' },
    { key: 'offers', label: `Offers to review${offersWaiting ? ` (${offersWaiting})` : ''}` },
    { key: 'find', label: 'Find sources' },
  ] as const;

  return (
    <>
      <PageHeader
        title="Sources & Licenses"
        subtitle="The sources you’re licensed to use, offers waiting for your decision, and new sources you can request."
      />
      <div className="mb-5 inline-flex rounded-lg border border-line bg-white p-1 text-sm">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setParams({ tab: t.key })}
            className={`rounded-md px-3 py-1.5 ${tab === t.key ? 'bg-ink text-white' : 'text-muted hover:text-ink'} ${t.key === 'offers' && offersWaiting && tab !== 'offers' ? 'font-semibold text-contract' : ''}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'offers' && <OffersPanel />}
      {tab === 'find' && <FindSourcesPanel />}
      {tab === 'licenses' && (
      <>
      <div>
        <AgGridReact<CatalogEntry>
          domLayout="autoHeight"
          theme={gridTheme}
          rowData={q.data!.assets.filter((a) => a.license || a.pending)}
          columnDefs={columns}
          rowSelection={{ mode: 'singleRow', checkboxes: false, enableClickSelection: true }}
          onSelectionChanged={(e) => setSelected(e.api.getSelectedRows()[0] ?? null)}
          defaultColDef={{ sortable: true, resizable: true }}
        />
      </div>

      {selected && (
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Card title={selected.assetTitle}>
            <p className="text-sm text-muted">{selected.description}</p>
            <dl className="mt-4 grid grid-cols-[9rem_1fr] gap-y-2 text-sm">
              <dt className="text-muted">Asset version</dt>
              <dd>
                <Hash value={selected.assetVersionId} n={32} /> v{selected.version}
              </dd>
              <dt className="text-muted">SHA-256</dt>
              <dd>
                <Hash value={selected.sha256} n={24} />
              </dd>
              <dt className="text-muted">Chunks</dt>
              <dd>{selected.chunkCount} retrievable passages</dd>
              <dt className="text-muted">License id</dt>
              <dd>
                <Hash value={selected.license?.id} n={32} /> v{selected.license?.version}
              </dd>
              <dt className="text-muted">Terms hash</dt>
              <dd>
                <Hash value={selected.license?.termsHash} n={24} />
              </dd>
              {selected.license?.terms.attributionText && (
                <>
                  <dt className="text-muted">Attribution</dt>
                  <dd>“{selected.license.terms.attributionText}”</dd>
                </>
              )}
            </dl>
          </Card>
          <Card title="What you're allowed to do">
            {selected.license ? <TermsSummary terms={selected.license.terms} /> : <p className="text-sm text-muted">No active license.</p>}
            {selected.license?.sourceText && (
              <details className="mt-4 text-sm">
                <summary className="cursor-pointer text-muted">Original license text</summary>
                <blockquote className="mt-2 border-l-2 border-line pl-3 text-slate-700">{selected.license.sourceText}</blockquote>
              </details>
            )}
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer text-muted">Technical details</summary>
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
