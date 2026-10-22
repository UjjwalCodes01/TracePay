import { useQuery } from '@tanstack/react-query';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { describeTerritories, formatDay, PURPOSE_LABELS, type Purpose } from '@tracepay/shared';
import { Badge, Card, ErrorNote, Hash, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { FindSourcesPanel, KIND_LABEL, OffersPanel } from './PublisherLicensing';
import { TermsSummary } from '../components/Terms';
import { api } from '../lib/api';
import { economicsLabel } from '../lib/format';
import { gridTheme } from '../lib/grid';
import type { CatalogEntry } from '../lib/types';

const DERIVATIVE_LABEL: Record<string, string> = {
  allowed: 'Allowed',
  allowed_with_attribution: 'Allowed, with a credit line',
  prohibited: 'Not allowed',
};

const yesNo = (v: boolean | undefined, yes = 'Allowed', no = 'Not allowed') =>
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
      { headerName: 'Source', field: 'assetTitle', pinned: 'left', width: 300, cellClass: 'font-medium', tooltip: true },
      { headerName: 'Owner', valueGetter: (p) => p.data?.owner.name, flex: 1.4, minWidth: 160 },
      { headerName: 'Type', field: 'kind', width: 140, valueFormatter: (p) => KIND_LABEL[String(p.value)] ?? String(p.value ?? '').replace(/_/g, ' ') },
      {
        headerName: 'License',
        width: 150,
        valueGetter: (p) => {
          const l = p.data?.license;
          if (!l) return p.data?.pending?.status ?? 'not_started';
          return l.terms.validUntil && l.terms.validUntil < today ? 'expired' : l.status;
        },
        cellRenderer: (p: ICellRendererParams) => (p.value === 'expired' ? <Badge tone="block">Expired</Badge> : <StatusBadge status={p.value} />),
      },
      {
        headerName: 'In reports that are sold',
        width: 180,
        valueGetter: (p) => p.data?.license?.terms.commercialUse,
        cellRenderer: (p: ICellRendererParams) => yesNo(p.value),
      },
      {
        headerName: 'May be used for',
        width: 240,
        valueGetter: (p) => {
          const purposes = p.data?.license?.terms.allowedPurposes;
          if (!purposes) return '—';
          const words = purposes.map((x: Purpose) => PURPOSE_LABELS[x] ?? x);
          return words.join(' and ').replace(/^./, (c) => c.toUpperCase());
        },
      },
      {
        headerName: 'Used to write reports',
        width: 200,
        valueGetter: (p) => {
          const d = p.data?.license?.terms.derivativeReports;
          return d ? (DERIVATIVE_LABEL[d] ?? d) : '—';
        },
      },
      {
        headerName: 'Original data shared',
        width: 170,
        valueGetter: (p) => p.data?.license?.terms.rawRedistribution,
        cellRenderer: (p: ICellRendererParams) => yesNo(p.value),
      },
      { headerName: 'Contributor’s share', width: 170, valueGetter: (p) => economicsLabel(p.data?.license?.terms.economics) },
      { headerName: 'Where', width: 170, valueGetter: (p) => (p.data?.license ? describeTerritories(p.data.license.terms.territories).replace(/^./, (c) => c.toUpperCase()) : '—') },
      {
        headerName: 'Paid when',
        width: 190,
        valueGetter: (p) => {
          const on = p.data?.license?.terms.payableOn;
          return !on ? '—' : on === 'cited_in_output' ? 'The report cites it' : 'A report uses it';
        },
      },
      {
        headerName: 'Valid until',
        width: 170,
        valueGetter: (p) => p.data?.license?.terms.validUntil ?? null,
        valueFormatter: (p) => (p.data?.license ? (p.value ? formatDay(String(p.value)) : 'No end date') : '—'),
      },
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
        title="Sources & licenses"
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
                  <dt className="text-muted">License</dt>
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
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer text-muted">Technical details</summary>
              <dl className="mt-2 grid grid-cols-[9rem_1fr] gap-y-2">
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
            </details>
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
