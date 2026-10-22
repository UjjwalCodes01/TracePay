import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Send } from 'lucide-react';
import { Badge, Button, Card, Empty, ErrorNote, Hash, PageHeader, Spinner, Stat, statusLabel, statusTone, TechnicalDetails } from '../components/ui';
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

/** PayPal's payout statuses, named as on every other screen. */
const label = (s: string) => ({ text: statusLabel(s), tone: statusTone(s) });
const FAILED = ['FAILED', 'RETURNED', 'BLOCKED', 'DENIED', 'REFUNDED', 'REVERSED'];

/**
 * Royalties from pay-per-citation answers. Each answer credits the contributors of the
 * passages it relied on; here the library owner pays what has built up, through
 * PayPal Payouts, and follows each payment to the end.
 */
export function RoyaltiesPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['royalties'], queryFn: () => api<Summary>('/royalties'), refetchInterval: 10_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['royalties'] });
  const send = useMutation({ mutationFn: () => post('/royalties/payouts'), onSettled: refresh });
  const act = useMutation({ mutationFn: ({ id, action }: { id: string; action: 'refresh' | 'resend' }) => post(`/royalties/payouts/${id}/${action}`), onSettled: refresh });

  if (q.isPending) return <Spinner />;
  if (!q.data) return <ErrorNote error={q.error ?? new Error('Royalties couldn’t be loaded. Try again in a moment.')} />;
  const s = q.data;
  const owed = s.accrued.reduce((n, a) => n + a.amountCents, 0);
  const payable = s.accrued.filter((a) => a.payable);

  return (
    <>
      <PageHeader
        title="Answer royalties"
        subtitle="Every AI answer from your library pays the contributors whose passages it relied on. Their earnings build up here; pay them all with PayPal in one go."
      />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Answers sold" value={s.answers} />
        <Stat label="Paid by askers" value={formatMoney(s.revenueCents)} />
        <Stat label="Owed to contributors" value={formatMoney(owed)} />
        <Stat label="Library fees (yours)" value={formatMoney(s.feesCents)} tone={s.feesCents > 0 ? 'pass' : undefined} />
      </div>

      <Card
        title="Ready to pay"
        action={
          <Button size="sm" loading={send.isPending} disabled={payable.length === 0} onClick={() => send.mutate()}>
            <Send className="size-4" aria-hidden /> {payable.length ? `Pay ${formatMoney(payable.reduce((n, a) => n + a.amountCents, 0))} with PayPal` : 'Pay with PayPal'}
          </Button>
        }
      >
        <ErrorNote error={send.error} />
        {s.accrued.length === 0 ? (
          <Empty>Nothing owed right now. When buyers or their AI agents ask questions, the contributors whose work they rely on earn here.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="pb-2 font-medium">Contributor</th>
                  <th className="hidden pb-2 text-right font-medium sm:table-cell">Answers</th>
                  <th className="hidden pb-2 text-right font-medium sm:table-cell">Passages cited</th>
                  <th className="pb-2 text-right font-medium">Owed</th>
                  <th className="pb-2 pl-4 font-medium">
                    <span className="sr-only">Status</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {s.accrued.map((a) => (
                  <tr key={a.contributorId}>
                    <td className="py-2 font-medium">
                      {a.name}
                      <span className="block text-xs font-normal text-muted sm:hidden">
                        {a.answers} {a.answers === 1 ? 'answer' : 'answers'} · {a.citations} {a.citations === 1 ? 'passage' : 'passages'}
                      </span>
                    </td>
                    <td className="hidden py-2 text-right tabular-nums sm:table-cell">{a.answers}</td>
                    <td className="hidden py-2 text-right tabular-nums sm:table-cell">{a.citations}</td>
                    <td className="py-2 text-right font-medium tabular-nums">{formatMoney(a.amountCents)}</td>
                    <td className="py-2 pl-4">
                      {a.payable ? <Badge tone="pass">Ready</Badge> : !a.hasPayee ? <Badge tone="warn">No PayPal email yet</Badge> : <Badge>Under the {formatMoney(s.minimumCents)} minimum</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted">
          Each payout gets a fixed reference before it is sent, so sending again can never pay twice. A payment that fails is added back to what’s owed and goes out with the next payout.
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
                  <span className="ml-auto flex flex-wrap gap-2">
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
                        <Badge tone={label(i.status).tone}>{label(i.status).text}</Badge>
                        <span className="w-16 text-right tabular-nums">{formatMoney(i.amountCents)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                {p.items.some((i) => FAILED.includes(i.status)) && (
                  <p className="mt-2 text-xs text-muted">Payments that didn’t go through are added back to what’s owed and go out with the next payout.</p>
                )}
                {(p.paypalBatchId || p.items.some((i) => i.transactionId)) && (
                  <TechnicalDetails className="text-xs text-muted">
                    <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-y-1.5">
                      {p.paypalBatchId && (
                        <>
                          <dt>PayPal batch ID</dt>
                          <dd><Hash value={p.paypalBatchId} n={20} /></dd>
                        </>
                      )}
                      {p.items.filter((i) => i.transactionId).map((i) => (
                        <div key={i.id} className="contents">
                          <dt>{i.name}</dt>
                          <dd><Hash value={i.transactionId} n={20} /> (PayPal payout ID)</dd>
                        </div>
                      ))}
                    </dl>
                  </TechnicalDetails>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
