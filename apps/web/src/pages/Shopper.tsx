import { PayPalButtons, PayPalScriptProvider } from '@paypal/react-paypal-js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Bot, CheckCircle2, CircleSlash, Search, ShieldCheck, ShoppingCart, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { DraftInput, parseDollars } from '../components/DraftInput';
import { Badge, Button, Card, ErrorNote, PageHeader, Spinner, statusLabel } from '../components/ui';
import { api, post } from '../lib/api';
import { formatDate, formatMoney, timeAgo } from '../lib/format';
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
  pending: { artifactId: string; title: string; priceCents: number; currency: string; reason: string; payment?: 'paid' | 'processing' | null } | null;
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
        subtitle="Tell the assistant what you need and how much you want to spend. It finds a report and checks that every source is licensed. Then it asks you to pay in PayPal — or, if you’ve saved PayPal for it, pays on its own within your limits."
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
                <ShoppingCart className="size-3.5 shrink-0" /> It pays only within the limits you set below; anything else, you approve in PayPal yourself.
              </li>
              <li className="flex gap-2">
                <Bot className="size-3.5 shrink-0" /> {usesAi ? 'Powered by Gemini.' : 'AI model not configured here: a simple rule-based assistant stands in.'}
              </li>
            </ul>
          </Card>

          <MandateCard />

          {runs.data && runs.data.runs.length > 0 && (
            <Card title="Earlier requests">
              <ul className="divide-y divide-line text-sm">
                {runs.data.runs.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setRunId(r.id)}
                      aria-pressed={r.id === current}
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

interface Mandate {
  id: string;
  status: 'pending' | 'active' | 'revoked';
  maxPerPurchaseCents: number;
  maxTotalCents: number;
  spentCents: number;
  remainingCents: number;
  expiresAt: string;
  payerEmail: string | null;
  expired: boolean;
}

/**
 * Agentic payments: the buyer saves PayPal once (in PayPal's vault) with limits, and the assistant may
 * then pay on its own within them. The limits are enforced by the server, not the model.
 */
function MandateCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['mandate'], queryFn: () => api<{ mandate: Mandate | null }>('/shopper/mandate') });
  const [perPurchase, setPerPurchase] = useState(2500);
  const [total, setTotal] = useState(5000);
  const [days, setDays] = useState(30);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['mandate'] });

  const start = useMutation({
    mutationFn: () => post<{ approveUrl: string }>('/shopper/mandate', { maxPerPurchaseCents: perPurchase, maxTotalCents: Math.max(total, perPurchase), days }),
    onSuccess: (r) => window.location.assign(r.approveUrl),
  });
  const activate = useMutation({
    mutationFn: (id: string) => post<{ mandate: Mandate }>(`/shopper/mandate/${id}/activate`),
    onSuccess: () => {
      setNotice('PayPal is saved for your assistant. It can now pay on its own within your limits.');
      void refresh();
    },
  });
  const revoke = useMutation({ mutationFn: () => api('/shopper/mandate', { method: 'DELETE' }), onSuccess: () => void refresh() });

  // Back from PayPal: switch the mandate on (or note that the buyer cancelled).
  const handled = useRef(false);
  const { mutate: activateMandate } = activate;
  useEffect(() => {
    if (handled.current) return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get('mandate');
    if (!id) return;
    handled.current = true;
    window.history.replaceState(null, '', window.location.pathname);
    if (params.get('cancelled')) setNotice('You didn’t save PayPal, so the assistant will keep asking before every payment.');
    else activateMandate(id);
  }, [activateMandate]);

  const m = q.data?.mandate;
  const active = m?.status === 'active' && !m.expired;
  return (
    <Card title="Let the assistant pay for you">
      <div aria-live="polite">
        {notice && <p className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-sm">{notice}</p>}
        {activate.isPending && <Spinner label="Saving PayPal for your assistant…" />}
      </div>
      {q.isPending ? (
        <Spinner />
      ) : m && active ? (
        <div className="space-y-3 text-sm">
          <p>
            The assistant may pay with your saved PayPal{m.payerEmail ? ` (${m.payerEmail})` : ''}: up to <strong>{formatMoney(m.maxPerPurchaseCents)}</strong> a purchase and{' '}
            <strong>{formatMoney(m.maxTotalCents)}</strong> in all, until {formatDate(m.expiresAt)}.
          </p>
          <div>
            <div className="flex justify-between text-xs text-muted">
              <span>Spent {formatMoney(m.spentCents)}</span>
              <span>{formatMoney(m.remainingCents)} left</span>
            </div>
            <div
              className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100"
              role="progressbar"
              aria-label="Share of the limit spent"
              aria-valuemin={0}
              aria-valuemax={m.maxTotalCents}
              aria-valuenow={m.spentCents}
            >
              <div className="h-full bg-ink" style={{ width: `${Math.min(100, (m.spentCents / m.maxTotalCents) * 100)}%` }} />
            </div>
          </div>
          <Button variant="secondary" size="sm" loading={revoke.isPending} onClick={() => revoke.mutate()}>
            Stop, and remove saved PayPal
          </Button>
          <ErrorNote error={revoke.error} />
        </div>
      ) : (
        <form
          className="space-y-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            start.mutate();
          }}
        >
          <p className="text-muted">
            Save PayPal once and set limits, and the assistant can buy on its own — the server checks every payment against them. You can stop it at any time.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <MoneyField label="Most per purchase" value={perPurchase} onChange={setPerPurchase} />
            <MoneyField label="Most in total" value={total} onChange={setTotal} />
            <label className="grid content-start gap-1">
              <span className="font-medium">For</span>
              <select className="h-10 w-full min-w-0 rounded-lg border border-line bg-white px-2" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {[7, 30, 90].map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Button type="submit" loading={start.isPending}>
            Save PayPal for my assistant
          </Button>
          <ErrorNote error={start.error ?? activate.error} />
        </form>
      )}
    </Card>
  );
}

function MoneyField({ label, value, onChange }: { label: string; value: number; onChange: (cents: number) => void }) {
  return (
    <label className="grid content-start gap-1">
      <span className="font-medium">{label}</span>
      <DraftInput
        inputMode="decimal"
        className="h-10 w-full min-w-0 rounded-lg border border-line px-3 tabular-nums"
        value={formatMoney(value)}
        onCommit={(text) => {
          const cents = parseDollars(text);
          if (cents !== null) onChange(Math.min(50_000, Math.max(100, cents)));
        }}
      />
    </label>
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
    // Quick while it works, slow while it waits for you, not at all once it's over. A failed check
    // (a busy or waking server) backs off and tries again rather than freezing the trace.
    refetchInterval: (query) => {
      const s = query.state.data?.run.status;
      const base = s === 'running' ? 1000 : s === 'awaiting_approval' ? 5000 : query.state.data ? false : 5000;
      if (base === false) return false;
      const fails = query.state.fetchFailureCount;
      return fails ? Math.min(30_000, base * 2 ** fails) : base;
    },
    retry: 1,
  });
  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['shopper-run', runId] });
    qc.invalidateQueries({ queryKey: ['shopper-runs'] });
  }, [qc, runId]);
  const stop = useMutation({ mutationFn: () => post(`/shopper/runs/${runId}/cancel`), onSettled: refresh });
  // Keep the "Earlier requests" badges in step with this run.
  const status = q.data?.run.status;
  useEffect(() => {
    if (status) qc.invalidateQueries({ queryKey: ['shopper-runs'] });
  }, [status, qc]);

  if (q.error && !q.data) return <ErrorNote error={q.error} />;
  if (!q.data) return <Spinner />;
  const run = q.data.run;
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
      {q.error && <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">Couldn’t check for updates just now; trying again.</p>}
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
        <div className="mt-5 whitespace-pre-line rounded-lg bg-slate-50 p-4 text-sm">
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
  // PayPal approved; the server is taking and checking the payment.
  const [capturing, setCapturing] = useState(false);
  const shownRef = useRef(false);
  // What PayPal has for this proposal (worked out by the server, since the proposal was made) —
  // set after a reload, a lost reply or a payment PayPal finished later.
  const paid = pending.payment === 'paid';
  const processing = pending.payment === 'processing';
  const decide = useMutation({
    mutationFn: (approved: boolean) => post(`/shopper/runs/${runId}/decision`, { approved }),
    onSettled: onDone,
  });
  // Once paid, the server carries the run on by itself as the page keeps checking it.
  useEffect(() => {
    if (!paid && !processing) return;
    const t = setInterval(onDone, paid ? 2000 : 5000);
    return () => clearInterval(t);
  }, [paid, processing, onDone]);
  const locked = capturing || paid || processing;

  return (
    <div className="mt-5 rounded-xl border-2 border-ink/80 p-4">
      <div className="text-xs font-medium text-muted">The assistant suggests</div>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
        <Link to={`/store/${pending.artifactId}`} className="font-semibold hover:underline">
          {pending.title}
        </Link>
        <span className="text-xl font-semibold tabular-nums">{formatMoney(pending.priceCents)}</span>
      </div>
      <p className="mt-2 text-sm text-slate-700">{pending.reason}</p>

      <div aria-live="polite">
        {paid ? (
          <p className="mt-4 flex items-start gap-2 text-sm font-medium text-pass">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> Payment received — the assistant is continuing.
          </p>
        ) : processing ? (
          <p className="mt-4 text-sm text-muted">PayPal is still processing your payment. The assistant carries on as soon as PayPal confirms it — you can come back later.</p>
        ) : capturing ? (
          <div className="mt-4">
            <Spinner label="Confirming your payment with PayPal…" />
          </div>
        ) : null}
      </div>
      {!locked && (
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
                    qc.invalidateQueries({ queryKey: ['my-purchases'] });
                    throw e;
                  }
                }}
                onApprove={async () => {
                  setCapturing(true);
                  try {
                    // The server captures and verifies the payment, then the assistant continues.
                    const r = await post<{ saleStatus: string }>(`/checkout/${saleRef.current}/capture`);
                    qc.invalidateQueries({ queryKey: ['artifacts'] });
                    await qc.invalidateQueries({ queryKey: ['my-purchases'] });
                    if (r.saleStatus === 'captured') decide.mutate(true);
                    else if (r.saleStatus !== 'pending_payment') setError(new Error('PayPal didn’t complete this payment, so nothing was charged.'));
                  } catch (e) {
                    setError(e);
                    qc.invalidateQueries({ queryKey: ['my-purchases'] });
                  } finally {
                    setCapturing(false);
                  }
                }}
                onCancel={() => setError(new Error('Payment cancelled. Nothing was charged.'))}
                onError={() => {
                  if (!shownRef.current) setError(new Error('PayPal reported a problem. Nothing was charged.'));
                }}
              />
            </PayPalScriptProvider>
          )}
          <Button variant="secondary" loading={decide.isPending && decide.variables === false} disabled={decide.isPending} onClick={() => decide.mutate(false)}>
            <CircleSlash className="size-4" /> No thanks
          </Button>
        </div>
      )}
      {config?.sandboxBuyerHint && !locked && <p className="mt-2 text-xs text-muted">Test buyer: {config.sandboxBuyerHint}</p>}
      {/* After a payment, a failed "yes" doesn't matter: the server resumes the run itself. */}
      <ErrorNote error={error ?? (paid ? null : decide.error)} />
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
      if (o.purchased === true && o.by === 'mandate')
        return { text: `The assistant paid ${str(o.amount)} on its own with your saved PayPal, within your limits (${str(o.mandateLeft)} left). The report is yours.`, tone: 'good' };
      if (o.purchased === true) return { text: `You paid ${str(o.amount)} with PayPal. The report is yours.`, tone: 'good' };
      if (o.approved === false) return { text: 'You decided not to buy it.' };
      return null;
    default:
      return null;
  }
}
