import { useQuery } from '@tanstack/react-query';
import { GitBranch, ScrollText } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { ReportBody } from '../components/ReportBody';
import { Badge, buttonClass, Card, ErrorNote, Hash, PageHeader, Spinner, TechnicalDetails } from '../components/ui';
import { api } from '../lib/api';
import { formatMoney } from '../lib/format';
import { useSession } from '../lib/session';
import type { ArtifactFull } from '../lib/types';

export function ArtifactPage() {
  const { id } = useParams();
  const { user } = useSession();
  const q = useQuery({ queryKey: ['artifact', id], queryFn: () => api<{ artifact: ArtifactFull; full: boolean; access?: string }>(`/artifacts/${id}`) });
  const owner = q.data?.access === 'owner';
  // The publisher's own sales of this report (the API lists only theirs).
  const sales = useQuery({
    queryKey: ['artifact-sales', id],
    queryFn: () => api<{ sales: Array<{ id: string; status: string; amountCents: number; artifact: { id: string } }> }>('/sales'),
    enabled: owner,
  });
  if (q.error && !q.data) return <ErrorNote error={q.error} />;
  if (!q.data) return <Spinner />;
  const { artifact, full } = q.data;
  const sold = (sales.data?.sales ?? []).filter((s) => s.artifact.id === artifact.id && s.status === 'captured');

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
            <Link to={`/reports/${artifact.id}/provenance`} className={buttonClass({ variant: 'secondary' })}>
              <GitBranch className="size-4" /> Where it came from
            </Link>
            <Link to={`/reports/${artifact.id}/receipt`} className={buttonClass()}>
              <ScrollText className="size-4" /> Receipt
            </Link>
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>{full ? <ReportBody artifact={artifact} /> : <p className="text-sm text-muted">Preview only.</p>}</Card>
        <Card title="Price" className="self-start">
          <div className="text-3xl font-semibold tabular-nums">{formatMoney(artifact.priceCents)}</div>
          <p className="mt-1 text-sm text-muted">Paid with PayPal (sandbox: test money only). Each time it sells, the contributors get their share of the payment PayPal confirms.</p>
          {owner && sales.data && (
            <p className="mt-3 text-sm">
              {sold.length === 0 ? (
                'Not sold yet.'
              ) : (
                <>
                  Sold {sold.length === 1 ? 'once' : `${sold.length} times`} · {formatMoney(sold.reduce((n, s) => n + s.amountCents, 0))} paid by buyers.{' '}
                  <Link to="/settlements" className="font-medium text-brand hover:underline">Pay contributors</Link>
                </>
              )}
            </p>
          )}
          {owner || user?.role !== 'buyer' ? (
            <p className="mt-4 text-xs text-muted">Buyers find this report in the Report store.</p>
          ) : (
            !full && (
              <Link to={`/store/${artifact.id}`} className={buttonClass({ size: 'sm', className: 'mt-4' })}>
                See it in the Report store
              </Link>
            )
          )}
          <TechnicalDetails>
            <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-y-1.5 text-xs">
              <dt className="text-muted">Report ID</dt><dd><Hash value={artifact.id} n={20} /></dd>
              <dt className="text-muted">Content hash</dt><dd><Hash value={artifact.contentHash} n={20} /></dd>
            </dl>
          </TechnicalDetails>
        </Card>
      </div>
    </>
  );
}
