import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Send } from 'lucide-react';
import { Badge, Button, Card, Empty, ErrorNote, Hash, PageHeader, Spinner, Stat } from '../components/ui';
import { api, post } from '../lib/api';
import { formatMoney, timeAgo } from '../lib/format';

interface Summary {
  minimumCents: number;
  answers: number;
  revenueCents: number;
  feesCents: number;
  accrued: Array<{ contributorId: string; name: string; hasPayee: boolean; amountCents: number; citations: number; answers: number; payable: boolean }>;
  payouts: Array<{
    id: string;
    status: string;
    totalCents: number;
    paypalBatchId: string | null;
    createdAt: string;
    lastCheckedAt: string | null;
    items: Array<{ id: string; name: string; amountCents: number; status: string; transactionId: string | null; errorName: string | null }>;
  }>;
}

/** PayPal's payout statuses in plain words. */
const STATUS: Record<string, { text: string; tone: 'pass' | 'warn' | 'block' | 'neutral' | 'info' }> = {
  SUBMITTING: { text: 'Sending to PayPal', tone: 'info' },
  SUBMIT_FAILED: { text: 'PayPal didn’t accept it — send again', tone: 'block' },
  PENDING: { text: 'On its way', tone: 'info' },
  PROCESSING: { text: 'On its way', tone: 'info' },
  SUCCESS: { text: 'Paid', tone: 'pass' },
  UNCLAIMED: { text: 'Waiting to be claimed', tone: 'warn' },
  ONHOLD: { text: 'On hold at PayPal', tone: 'warn' },
  FAILED: { text: 'Failed — back in the next payout', tone: 'block' },
  RETURNED: { text: 'Returned — back in the next payout', tone: 'block' },
  BLOCKED: { text: 'Blocked — back in the next payout', tone: 'block' },
  DENIED: { text: 'Declined by PayPal — back in the next payout', tone: 'block' },
  CANCELED: { text: 'Cancelled', tone: 'block' },
};
const label = (s: string) => STATUS[s] ?? { text: s, tone: 'neutral' as const };

/**
 * Royalties from pay-per-citation answers. Each answer credits the authors of the
 * passages it relied on; here the library owner pays what has built up, through
 * PayPal Payouts, and follows each payment to the end.
 */
export function RoyaltiesPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['royalties'], queryFn: () => api<Summary>('/royalties'), refetchInterval: 10_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['royalties'] });
  const send = useMutation({ mutationFn: () => post('/royalties/payouts'), onSettled: refresh });
  const act = useMutation({ mutationFn: ({ id, action }: { id: string; action: 'refresh' | 'resend' }) => post(`/royalties/payouts/${id}/${action}`), onSettled: refresh });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const s = q.data!;
  const owed = s.accrued.reduce((n, a) => n + a.amountCents, 0);
  const payable = s.accrued.filter((a) => a.payable);

  return (
    <>
      <PageHeader
        title="Answer royalties"
        subtitle="Every AI answer from your library pays the authors of the passages it relied on. Their earnings build up here; send them with PayPal in one batch."
      />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Answers sold" value={s.answers} />
        <Stat label="Paid by askers" value={formatMoney(s.revenueCents)} />
        <Stat label="Owed to authors" value={formatMoney(owed)} />
        <Stat label="Your answer fees" value={formatMoney(s.feesCents)} tone="pass" />
      </div>

      <Card
        title="Ready to pay"
        action={
          <Button size="sm" loading={send.isPending} disabled={payable.length === 0} onClick={() => send.mutate()}>
            <Send className="size-4" /> Pay {payable.length ? formatMoney(payable.reduce((n, a) => n + a.amountCents, 0)) : ''} with PayPal
          </Button>
        }
      >
        <ErrorNote error={send.error} />
        {s.accrued.length === 0 ? (
          <Empty>Nothing owed right now. When buyers or their AI agents ask questions, the authors they rely on earn here.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="pb-2 font-medium">Author</th>
                <th className="pb-2 text-right font-medium">Answers</th>
                <th className="pb-2 text-right font-medium">Passages cited</th>
                <th className="pb-2 text-right font-medium">Owed</th>
                <th className="pb-2 pl-4 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {s.accrued.map((a) => (
                <tr key={a.contributorId}>
                  <td className="py-2 font-medium">{a.name}</td>
                  <td className="py-2 text-right tabular-nums">{a.answers}</td>
                  <td className="py-2 text-right tabular-nums">{a.citations}</td>
                  <td className="py-2 text-right font-medium tabular-nums">{formatMoney(a.amountCents)}</td>
                  <td className="py-2 pl-4">
                    {a.payable ? <Badge tone="pass">Ready</Badge> : !a.hasPayee ? <Badge tone="warn">No PayPal account on file</Badge> : <Badge>Below {formatMoney(s.minimumCents)} minimum</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-3 text-xs text-muted">
          Each batch has a fixed PayPal batch id before it is sent, so a retry can never pay twice. A payment that fails goes back into the pool for the next batch.
        </p>
      </Card>

      {s.payouts.length > 0 && (
        <Card title="PayPal payouts" className="mt-6">
          <ErrorNote error={act.error} />
          <div className="space-y-5">
            {s.payouts.map((p) => (
              <div key={p.id} className="rounded-lg border border-line p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-semibold tabular-nums">{formatMoney(p.totalCents)}</span>
                  <Badge tone={label(p.status).tone}>{label(p.status).text}</Badge>
                  <span className="text-muted">{timeAgo(p.createdAt)}</span>
                  {p.paypalBatchId && <Hash value={p.paypalBatchId} n={16} />}
                  <span className="ml-auto flex gap-2">
                    {p.status === 'SUBMIT_FAILED' && (
                      <Button size="sm" loading={act.isPending && act.variables?.id === p.id} onClick={() => act.mutate({ id: p.id, action: 'resend' })}>
                        <Send className="size-3.5" /> Send again
                      </Button>
                    )}
                    {p.paypalBatchId && (
                      <Button size="sm" variant="secondary" loading={act.isPending && act.variables?.id === p.id} onClick={() => act.mutate({ id: p.id, action: 'refresh' })}>
                        <RefreshCw className="size-3.5" /> Check with PayPal
                      </Button>
                    )}
                  </span>
                </div>
                <ul className="divide-y divide-line text-sm">
                  {p.items.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                      <span>{i.name}</span>
                      <span className="flex items-center gap-2">
                        {i.transactionId && <Hash value={i.transactionId} n={12} />}
                        <Badge tone={label(i.status).tone}>{label(i.status).text}</Badge>
                        <span className="w-16 text-right tabular-nums">{formatMoney(i.amountCents)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
