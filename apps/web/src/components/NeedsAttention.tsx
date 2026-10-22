import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, post } from '../lib/api';
import { timeAgo } from '../lib/format';
import { Button, ErrorNote } from './ui';

interface Issue {
  id: string;
  kind: string;
  title: string;
  detail: string;
  subject: { type: 'sale' | 'settlement' | 'payout_batch'; id: string };
  opened: string;
}

interface Summary {
  open_issues: number;
  watching: { payments: number; payout_batches: number };
  last_checked_at: string | null;
  next_check_at: string | null;
}

function inFuture(iso: string): string {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (s <= 60) return 'in a moment';
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 86400) return `in ${Math.round(s / 3600)} h`;
  return `on ${new Date(iso).toLocaleDateString()}`;
}

/**
 * "Needs attention": what reconciliation with PayPal found that a person should
 * look at, plus a plain statement of when TracePay last checked and will check next.
 */
export function NeedsAttention() {
  const qc = useQueryClient();
  const summary = useQuery({ queryKey: ['reconciliation'], queryFn: () => api<Summary>('/v1/reconciliation'), refetchInterval: 30_000 });
  const issues = useQuery({ queryKey: ['reconciliation-issues'], queryFn: () => api<{ data: Issue[] }>('/v1/reconciliation/issues?status=open&limit=20'), refetchInterval: 30_000 });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['reconciliation'] });
    qc.invalidateQueries({ queryKey: ['reconciliation-issues'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const check = useMutation({ mutationFn: () => post('/v1/reconciliation/check'), onSettled: refresh });

  const s = summary.data;
  const open = issues.data?.data ?? [];
  const total = s?.open_issues ?? open.length;
  const watching = s ? s.watching.payments + s.watching.payout_batches : 0;
  const loaded = !!s && !!issues.data;

  return (
    <section className="rounded-xl border border-line bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <h2 className="flex items-center gap-2 font-semibold">
          {!loaded ? (
            'Checking with PayPal…'
          ) : total ? (
            <>
              <AlertTriangle className="size-4 text-block" /> Needs your attention ({total})
            </>
          ) : (
            <>
              <CheckCircle2 className="size-4 text-pass" /> Everything matches PayPal
            </>
          )}
        </h2>
        <Button size="sm" variant="secondary" loading={check.isPending} onClick={() => check.mutate()}>
          <RefreshCw className="size-4" /> Check with PayPal now
        </Button>
      </div>
      <ErrorNote error={summary.error ?? issues.error ?? check.error} />
      {open.length > 0 && (
        <ul className="divide-y divide-line">
          {open.map((i) => (
            <IssueRow key={i.id} issue={i} onResolved={refresh} />
          ))}
        </ul>
      )}
      <p className="px-5 py-3 text-sm text-muted">
        TracePay checks your payments and contributor payouts with PayPal on its own — even if a PayPal notification gets lost.
        {s?.last_checked_at && ` Last checked ${timeAgo(s.last_checked_at)}.`}
        {watching > 0 && s?.next_check_at
          ? ` Still following ${watching} ${watching === 1 ? 'item' : 'items'}; next check ${inFuture(s.next_check_at)}.`
          : s
            ? ' Nothing is waiting on PayPal right now.'
            : ''}
      </p>
    </section>
  );
}

function IssueRow({ issue, onResolved }: { issue: Issue; onResolved: () => void }) {
  const [note, setNote] = useState<string | null>(null);
  const resolve = useMutation({
    mutationFn: () => post(`/v1/reconciliation/issues/${issue.id}/resolve`, { resolution: note }),
    onSuccess: () => {
      setNote(null);
      onResolved();
    },
  });
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-block">{issue.title}</div>
          <p className="mt-0.5 text-sm text-slate-700">{issue.detail}</p>
          <p className="mt-1 text-xs text-muted">Found {timeAgo(issue.opened)}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Link to="/settlements" className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-sm font-medium hover:bg-slate-50">
            Open payments
          </Link>
          {note === null && (
            <Button size="sm" variant="ghost" onClick={() => setNote('')}>
              Mark as handled
            </Button>
          )}
        </div>
      </div>
      {note !== null && (
        <form
          className="mt-3 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            resolve.mutate();
          }}
        >
          <input
            autoFocus
            required
            aria-label="What did you do to handle this?"
            minLength={3}
            maxLength={500}
            placeholder="What did you do? e.g. “Paid the contributors directly.”"
            className="h-9 min-w-64 flex-1 rounded-lg border border-line px-3 text-sm"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button size="sm" type="submit" loading={resolve.isPending}>
            Save
          </Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => setNote(null)}>
            Cancel
          </Button>
          <ErrorNote error={resolve.error} />
        </form>
      )}
    </li>
  );
}
