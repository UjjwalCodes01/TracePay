import { useQuery } from '@tanstack/react-query';
import { GitBranch, ScrollText } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { ReportBody } from '../components/ReportBody';
import { Badge, Card, ErrorNote, Hash, PageHeader, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { formatMoney } from '../lib/format';
import { useSession } from '../lib/session';
import type { ArtifactFull } from '../lib/types';

export function ArtifactPage() {
  const { id } = useParams();
  const { user } = useSession();
  const q = useQuery({ queryKey: ['artifact', id], queryFn: () => api<{ artifact: ArtifactFull; full: boolean; access?: string }>(`/artifacts/${id}`) });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const { artifact, full, access } = q.data!;
  const owner = access === 'owner';

  return (
    <>
      <PageHeader
        title={artifact.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {artifact.fromFixture ? <Badge tone="warn">Written without AI (no AI model configured)</Badge> : <Badge tone="ai">Written with AI ({artifact.model})</Badge>}
            {/* Previews don't include the citation check, so only judge it when it's there. */}
            {artifact.citationReport && (
              <Badge tone={artifact.citationReport.ok ? 'pass' : 'block'}>{artifact.citationReport.ok ? 'All citations verified' : 'Citation issues'}</Badge>
            )}
          </span>
        }
        action={
          <div className="flex flex-wrap gap-2">
            <Link to={`/reports/${artifact.id}/provenance`} className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-white px-4 text-sm font-medium hover:bg-slate-50">
              <GitBranch className="size-4" /> Where it came from
            </Link>
            <Link to={`/reports/${artifact.id}/receipt`} className="inline-flex h-10 items-center gap-2 rounded-lg bg-ink px-4 text-sm font-medium text-white hover:bg-slate-800">
              <ScrollText className="size-4" /> Receipt
            </Link>
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>{full ? <ReportBody artifact={artifact} /> : <p className="text-sm text-muted">Preview only.</p>}</Card>
        <Card title="Price">
          <div className="text-3xl font-semibold tabular-nums">{formatMoney(artifact.priceCents)}</div>
          <p className="mt-1 text-sm text-muted">Paid with PayPal (sandbox: test money only). Each time it sells, the contributors get their share of the payment PayPal confirms.</p>
          {owner || user?.role !== 'buyer' ? (
            <p className="mt-4 text-xs text-muted">Buyers find this report in the Report store.</p>
          ) : (
            !full && (
              <Link to={`/store/${artifact.id}`} className="mt-4 inline-flex h-9 items-center rounded-lg bg-ink px-3 text-sm font-medium text-white hover:bg-slate-800">
                See it in the Report store
              </Link>
            )
          )}
          <details className="mt-4 rounded-lg border border-line bg-slate-50 text-sm">
            <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted hover:text-ink">Technical details</summary>
            <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-y-1.5 border-t border-line px-3 py-3 text-xs">
              <dt className="text-muted">Report ID</dt><dd><Hash value={artifact.id} n={20} /></dd>
              <dt className="text-muted">Content hash</dt><dd><Hash value={artifact.contentHash} n={20} /></dd>
            </dl>
          </details>
        </Card>
      </div>
    </>
  );
}
