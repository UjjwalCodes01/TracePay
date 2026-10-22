import { PayPalButtons, PayPalScriptProvider } from '@paypal/react-paypal-js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Bot, CheckCircle2, CircleSlash, Search, ShieldCheck, ShoppingCart, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { DraftInput, parseDollars } from '../components/DraftInput';
import { Badge, Button, Card, ErrorNote, PageHeader, Spinner, statusLabel } from '../components/ui';
import { api, post } from '../lib/api';
import { formatMoney, timeAgo } from '../lib/format';
import { useSession } from '../lib/session';

interface Step {
  id: string;
  ordinal: number;
  kind: 'plan' | 'tool_call' | 'tool_result' | 'approval_request' | 'message' | 'error';
  tool: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
}

interface ShopperRun {
  id: string;
  goal: string;
  status: 'running' | 'awaiting_approval' | 'completed' | 'failed';
  model: string | null;
  policy: { budgetCents: number; maxPurchases: number };
  summary: string | null;
  createdAt: string;
  pending: { artifactId: string; title: string; priceCents: number; currency: string; reason: string } | null;
  steps: Step[];
}

type RunListItem = Pick<ShopperRun, 'id' | 'goal' | 'status' | 'policy' | 'summary' | 'createdAt'>;

const DEFAULT_GOAL = 'I need a recent market brief on developer tools and how teams are adopting AI coding assistants.';

const STATUS: Record<ShopperRun['status'], { label: string; tone: 'info' | 'warn' | 'pass' | 'block' }> = {
  running: { label: 'Working', tone: 'info' },
  awaiting_approval: { label: 'Waiting for you', tone: 'warn' },
  completed: { label: 'Done', tone: 'pass' },
  failed: { label: 'Stopped', tone: 'block' },
};
const statusOf = (s: string) => STATUS[s as ShopperRun['status']] ?? { label: statusLabel(s), tone: 'info' as const };

/**
 * The buyer's Shopping Assistant (agentic commerce): an AI that searches the store,
 * checks each report's licenses and citations, and proposes one purchase within the
 * buyer's budget. Money only moves when the buyer approves the payment in PayPal.
 */
export function ShopperPage() {
  const qc = useQueryClient();
  const { config } = useSession();
  const [goal, setGoal] = useState(DEFAULT_GOAL);
  const [budgetCents, setBudgetCents] = useState(2500);
  const [runId, setRunId] = useState<string | null>(null);

  const runs = useQuery({ queryKey: ['shopper-runs'], queryFn: () => api<{ runs: RunListItem[] }>('/shopper/runs') });
  const start = useMutation({
    mutationFn: () => post<{ runId: string }>('/shopper/runs', { goal, budgetCents }),
    onSuccess: (r) => {
      setRunId(r.runId);
      qc.invalidateQueries({ queryKey: ['shopper-runs'] });
    },
  });
  const current = runId ?? runs.data?.runs[0]?.id ?? null;
  const usesAi = config?.agentPlanner === 'gemini';

  return (
    <>
      <PageHeader
        title="Shopping assistant"
        subtitle="Tell the assistant what you need and how much you want to spend. It finds a report, checks that every source is licensed, and asks before you pay — you approve the payment in PayPal."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="space-y-6">
          <Card title="What are you looking for?">
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                start.mutate();
              }}
            >
              <textarea
                aria-label="What you are looking for"
                className="h-28 w-full rounded-lg border border-line p-3 text-sm"
                value={goal}
                minLength={10}
                maxLength={1000}
                required
                onChange={(e) => setGoal(e.target.value)}
              />
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Most you want to spend</span>
                <DraftInput
                  inputMode="decimal"
                  className="h-10 w-40 rounded-lg border border-line px-3 tabular-nums"
                  value={formatMoney(budgetCents)}
                  onCommit={(text) => {
                    const cents = parseDollars(text);
                    if (cents !== null) setBudgetCents(Math.min(100_000, Math.max(100, cents)));
                  }}
                />
                <span className="mt-1 block text-xs text-muted">Between $1 and $1,000. The assistant can never go over it.</span>
              </label>
              <Button type="submit" loading={start.isPending}>
                <Bot className="size-4" /> Find me a report
              </Button>
              <ErrorNote error={start.error} />
            </form>
            <ul className="mt-5 space-y-1.5 border-t border-line pt-4 text-xs text-muted">
              <li className="flex gap-2">
                <ShieldCheck className="size-3.5 shrink-0 text-pass" /> It only suggests reports whose sources are licensed for sale today.
              </li>
              <li className="flex gap-2">
                <ShoppingCart className="size-3.5 shrink-0" /> It can’t pay. You see its reason and approve the payment in PayPal yourself.
              </li>
              <li className="flex gap-2">
                <Bot className="size-3.5 shrink-0" /> {usesAi ? 'Powered by Gemini.' : 'AI model not configured here: a simple rule-based assistant stands in.'}
              </li>
            </ul>
          </Card>

          {runs.data && runs.data.runs.length > 0 && (
            <Card title="Earlier requests">
              <ul className="divide-y divide-line text-sm">
                {runs.data.runs.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setRunId(r.id)}
                      className={clsx('flex w-full items-start justify-between gap-3 py-2.5 text-left', r.id === current && 'font-medium')}
                    >
                      <span className="line-clamp-2 min-w-0">{r.goal}</span>
                      <span className="shrink-0 text-right">
                        <Badge tone={statusOf(r.status).tone}>{statusOf(r.status).label}</Badge>
                        <span className="mt-0.5 block text-xs font-normal text-muted">{timeAgo(r.createdAt)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div>{current ? <RunView key={current} runId={current} /> : <EmptyRun />}</div>
      </div>
    </>
  );
}

function EmptyRun() {
  return (
    <Card>
      <div className="py-10 text-center text-sm text-muted">
        <Search className="mx-auto mb-3 size-6" />
        Describe what you need and set a budget. You’ll see every step the assistant takes here.
      </div>
    </Card>
  );
}

function RunView({ runId }: { runId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['shopper-run', runId],
    queryFn: () => api<{ run: ShopperRun }>(`/shopper/runs/${runId}`),
    // Quick while it works, slow while it waits for you, not at all once it's over (or broken).
    refetchInterval: (query) => {
      if (query.state.error) return false;
      const s = query.state.data?.run.status;
      return s === 'running' ? 1000 : s === 'awaiting_approval' ? 5000 : false;
    },
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['shopper-run', runId] });
    qc.invalidateQueries({ queryKey: ['shopper-runs'] });
  };
  const stop = useMutation({ mutationFn: () => post(`/shopper/runs/${runId}/cancel`), onSettled: refresh });
  // Keep the "Earlier requests" badges in step with this run.
  const status = q.data?.run.status;
  useEffect(() => {
    if (status) qc.invalidateQueries({ queryKey: ['shopper-runs'] });
  }, [status, qc]);

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const run = q.data!.run;
  const busy = run.status === 'running' || run.status === 'awaiting_approval';

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Badge tone={statusOf(run.status).tone}>{statusOf(run.status).label}</Badge>
          <span className="text-sm font-normal text-muted">Budget {formatMoney(run.policy.budgetCents)}</span>
        </span>
      }
      action={
        busy ? (
          <Button size="sm" variant="ghost" loading={stop.isPending} onClick={() => stop.mutate()}>
            <Square className="size-3.5" /> Stop
          </Button>
        ) : undefined
      }
    >
      <p className="mb-4 text-sm text-slate-700">“{run.goal}”</p>
      <ol className="space-y-2.5" aria-live="polite">
        {run.steps.map((s) => {
          const line = describe(s);
          return line ? (
            <li key={s.id} className={clsx('flex gap-2.5 text-sm', line.tone === 'bad' && 'text-block', line.tone === 'good' && 'text-pass')}>
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-current opacity-60" />
              <span>{line.text}</span>
            </li>
          ) : null;
        })}
        {run.status === 'running' && (
          <li className="flex gap-2.5 text-sm text-muted">
            <span className="mt-1.5 size-1.5 shrink-0 animate-pulse rounded-full bg-current motion-reduce:animate-none" aria-hidden /> Working…
          </li>
        )}
      </ol>
      {run.status === 'awaiting_approval' && run.pending && <Approve runId={runId} pending={run.pending} onDone={refresh} />}
      <ErrorNote error={stop.error} />
      {run.status === 'completed' && run.summary && (
        <div className="mt-5 rounded-lg bg-slate-50 p-4 text-sm">
          <div className="mb-1 flex items-center gap-1.5 font-medium">
            <CheckCircle2 className="size-4 text-pass" /> Summary
          </div>
          {run.summary}
        </div>
      )}
      {run.status === 'failed' && run.summary && <p className="mt-5 text-sm text-block">{run.summary}</p>}
    </Card>
  );
}

/** The proposal, with PayPal's own buttons: the buyer pays (or says no) right here. */
function Approve({ runId, pending, onDone }: { runId: string; pending: NonNullable<ShopperRun['pending']>; onDone: () => void }) {
  const qc = useQueryClient();
  const { config } = useSession();
  const saleRef = useRef<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [processing, setProcessing] = useState(false);
  const shownRef = useRef(false);
  const decide = useMutation({
    mutationFn: (approved: boolean) => post(`/shopper/runs/${runId}/decision`, { approved }),
    onSuccess: onDone,
  });

  return (
    <div className="mt-5 rounded-xl border-2 border-ink/80 p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">The assistant suggests</div>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
        <Link to={`/store/${pending.artifactId}`} className="font-semibold hover:underline">
          {pending.title}
        </Link>
        <span className="text-xl font-semibold tabular-nums">{formatMoney(pending.priceCents)}</span>
      </div>
      <p className="mt-2 text-sm text-slate-700">{pending.reason}</p>

      {processing ? (
        <p className="mt-4 text-sm text-muted">PayPal is still processing your payment. The assistant carries on as soon as PayPal confirms it — you can come back later.</p>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          {!config?.paypalClientId ? (
            <ErrorNote error={new Error('PayPal sandbox is not configured on the server.')} />
          ) : (
            <PayPalScriptProvider options={{ clientId: config.paypalClientId, currency: 'USD', intent: 'capture', components: 'buttons' }}>
              <PayPalButtons
                style={{ layout: 'vertical', shape: 'rect', label: 'pay', height: 40 }}
                disabled={decide.isPending}
                createOrder={async () => {
                  setError(null);
                  shownRef.current = false;
                  try {
                    const r = await post<{ saleId: string; orderId: string }>('/checkout/orders', { artifactId: pending.artifactId });
                    saleRef.current = r.saleId;
                    return r.orderId;
                  } catch (e) {
                    // Our own message (e.g. "already owned", rate limit) — PayPal's generic onError mustn't replace it.
                    shownRef.current = true;
                    setError(e);
                    throw e;
                  }
                }}
                onApprove={async () => {
                  try {
                    // The server captures and verifies the payment, then the assistant continues.
                    const r = await post<{ saleStatus: string }>(`/checkout/${saleRef.current}/capture`);
                    qc.invalidateQueries({ queryKey: ['artifacts'] });
                    qc.invalidateQueries({ queryKey: ['my-purchases'] });
                    if (r.saleStatus === 'pending_payment') setProcessing(true);
                    else if (r.saleStatus === 'captured') decide.mutate(true);
                    else setError(new Error('PayPal didn’t complete this payment, so nothing was charged.'));
                  } catch (e) {
                    setError(e);
                  }
                }}
                onCancel={() => setError(new Error('Payment cancelled. Nothing was charged.'))}
                onError={() => {
                  if (!shownRef.current) setError(new Error('PayPal reported a problem. Nothing was charged.'));
                }}
              />
            </PayPalScriptProvider>
          )}
          <Button variant="secondary" loading={decide.isPending && decide.variables === false} onClick={() => decide.mutate(false)}>
            <CircleSlash className="size-4" /> No thanks
          </Button>
        </div>
      )}
      {config?.sandboxBuyerHint && <p className="mt-2 text-xs text-muted">Test buyer: {config.sandboxBuyerHint}</p>}
      <ErrorNote error={error ?? decide.error} />
    </div>
  );
}

/** Each recorded step as one plain sentence; bookkeeping steps are skipped. */
function describe(s: Step): { text: string; tone?: 'good' | 'bad' } | null {
  const o = s.output ?? {};
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  if (s.kind === 'error') return { text: `Stopped: ${str(o.message)}`, tone: 'bad' };
  if (s.kind === 'plan' && s.ordinal === 0) return null; // the request itself, shown above
  if (s.kind === 'message') return null; // the final answer: shown as the summary
  if (s.kind === 'plan') return o.text ? { text: str(o.text) } : null;
  if (s.kind === 'approval_request') return { text: `Suggested buying “${str(o.title)}” for ${formatMoney(Number(o.priceCents) || 0)}. Waiting for your decision.` };
  if (s.kind === 'tool_call') return null; // the result says it better
  // tool results
  if (o.error) return { text: `Not allowed: ${str(o.message)}`, tone: 'bad' };
  switch (s.tool) {
    case 'search_reports': {
      const reports = (o.reports as Array<{ fitsBudget: boolean; match: number }> | undefined) ?? [];
      const relevant = reports.filter((r) => r.match > 0);
      return { text: `Found ${relevant.length} matching ${relevant.length === 1 ? 'report' : 'reports'}; ${relevant.filter((r) => r.fitsBudget).length} within your budget (${str(o.remainingBudget)} left).` };
    }
    case 'inspect_report': {
      const okAll = o.licensesValidToday && o.citationsCheckOut;
      return {
        text: `Checked “${str(o.title)}” (${str(o.price)}): ${o.licensesValidToday ? 'every source is licensed for sale today' : 'a source’s license no longer allows selling it'}, and ${o.citationsCheckOut ? `all ${Number(o.citations)} citations check out` : 'its citations don’t check out'}.`,
        tone: okAll ? 'good' : 'bad',
      };
    }
    case 'propose_purchase':
      if (o.purchased === true) return { text: `You paid ${str(o.amount)} with PayPal. The report is yours.`, tone: 'good' };
      if (o.approved === false) return { text: 'You decided not to buy it.' };
      return null;
    default:
      return null;
  }
}
