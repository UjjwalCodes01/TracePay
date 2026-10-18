import { useQuery } from '@tanstack/react-query';
import { GitBranch, ScrollText } from 'lucide-react';
import { Link } from 'react-router';
import { Badge, Empty, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { formatMoney, timeAgo } from '../lib/format';
import type { ArtifactPreview } from '../lib/types';

export function ReportsPage() {
  const q = useQuery({ queryKey: ['artifacts'], queryFn: () => api<{ artifacts: ArtifactPreview[] }>('/artifacts') });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const artifacts = q.data!.artifacts;

  return (
    <>
      <PageHeader title="My Reports" subtitle="Reports you’ve created. Each one was checked against its sources’ licenses before it was written." />
      {artifacts.length === 0 ? (
        <Empty>
          No reports yet. <Link className="font-medium text-ink underline" to="/studio">Create your first report</Link>.
        </Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {artifacts.map((a) => (
            <article key={a.id} className="rounded-xl border border-line bg-white p-5">
              <div className="flex items-start justify-between gap-3">
                <Link to={`/reports/${a.id}`} className="font-semibold hover:underline">
                  {a.title}
                </Link>
                <span className="text-lg font-semibold tabular-nums">{formatMoney(a.priceCents)}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {a.fromFixture ? <Badge tone="warn">Fixture output</Badge> : <Badge tone="ai">{a.model}</Badge>}
                <Badge>{a.sources.filter((s) => s.cited).length}/{a.sources.length} sources cited</Badge>
                <Badge tone="neutral">{timeAgo(a.createdAt)}</Badge>
              </div>
              {a.summary && <p className="mt-3 line-clamp-3 text-sm text-muted">{a.summary}</p>}
              <div className="mt-4 flex gap-4 text-sm">
                <Link to={`/reports/${a.id}/provenance`} className="inline-flex items-center gap-1.5 font-medium text-brand hover:underline">
                  <GitBranch className="size-4" /> Provenance
                </Link>
                <Link to={`/reports/${a.id}/receipt`} className="inline-flex items-center gap-1.5 font-medium text-brand hover:underline">
                  <ScrollText className="size-4" /> Audit receipt
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
