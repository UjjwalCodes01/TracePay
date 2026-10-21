import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, GitBranch, ScrollText } from 'lucide-react';
import { Link } from 'react-router';
import { Badge, Button, Empty, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { api, post } from '../lib/api';
import { formatMoney, timeAgo } from '../lib/format';
import type { ArtifactPreview } from '../lib/types';

type MyReport = ArtifactPreview & { withdrawnReason: string | null };

const STATUS = {
  listed: { label: 'On sale', tone: 'pass' },
  withdrawn: { label: 'Off sale', tone: 'block' },
  draft: { label: 'Internal only', tone: 'neutral' },
} as const;

export function ReportsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['my-reports'], queryFn: () => api<{ reports: MyReport[] }>('/reports') });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'withdraw' | 'relist' }) => post(`/artifacts/${id}/${action}`),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['my-reports'] });
      qc.invalidateQueries({ queryKey: ['artifacts'] });
    },
  });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const reports = q.data!.reports;

  return (
    <>
      <PageHeader title="My Reports" subtitle="Reports you’ve created. Before every sale TracePay re-checks that each source’s license still allows it." />
      <ErrorNote error={act.error} />
      {reports.length === 0 ? (
        <Empty>
          No reports yet. <Link className="font-medium text-ink underline" to="/studio">Create your first report</Link>.
        </Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {reports.map((a) => {
            const st = STATUS[a.status as keyof typeof STATUS] ?? { label: a.status, tone: 'neutral' as const };
            return (
              <article key={a.id} className="flex flex-col rounded-xl border border-line bg-white p-5">
                <div className="flex items-start justify-between gap-3">
                  <Link to={`/reports/${a.id}`} className="font-semibold hover:underline">
                    {a.title}
                  </Link>
                  <span className="text-lg font-semibold tabular-nums">{formatMoney(a.priceCents)}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge tone={st.tone}>{st.label}</Badge>
                  {a.fromFixture ? <Badge tone="warn">Demo AI output</Badge> : <Badge tone="ai">Written by Gemini</Badge>}
                  <Badge>{timeAgo(a.createdAt)}</Badge>
                </div>
                {a.status === 'withdrawn' && a.withdrawnReason && (
                  <p className="mt-3 flex gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-block">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {a.withdrawnReason}
                  </p>
                )}
                {a.summary && <p className="mt-3 line-clamp-3 flex-1 text-sm text-muted">{a.summary}</p>}
                <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
                  <Link to={`/reports/${a.id}/provenance`} className="inline-flex items-center gap-1.5 font-medium text-brand hover:underline">
                    <GitBranch className="size-4" /> Provenance
                  </Link>
                  <Link to={`/reports/${a.id}/receipt`} className="inline-flex items-center gap-1.5 font-medium text-brand hover:underline">
                    <ScrollText className="size-4" /> Audit receipt
                  </Link>
                  <span className="flex-1" />
                  {a.status === 'listed' && (
                    <Button size="sm" variant="ghost" loading={act.isPending && act.variables?.id === a.id && act.variables.action === 'withdraw'} disabled={act.isPending} onClick={() => confirm('Take this report off sale?') && act.mutate({ id: a.id, action: 'withdraw' })}>
                      Take off sale
                    </Button>
                  )}
                  {a.status === 'withdrawn' && (
                    <Button size="sm" variant="secondary" loading={act.isPending && act.variables?.id === a.id && act.variables.action === 'relist'} disabled={act.isPending} onClick={() => act.mutate({ id: a.id, action: 'relist' })}>
                      Put back on sale
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
