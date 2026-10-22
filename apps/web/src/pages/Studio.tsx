import type { BuildIntent } from '@tracepay/shared';
import { describeTerritory, formatDay } from '@tracepay/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Bot, ListChecks, Sparkles } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { AgentTrace } from '../components/AgentTrace';
import { DraftInput, parseDollars } from '../components/DraftInput';
import { PreflightMatrix } from '../components/PreflightMatrix';
import { Badge, Button, Card, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { ApiError, api, post } from '../lib/api';
import { economicsLabel } from '../lib/format';
import type { AgentRun, CatalogEntry, Explanation, PreflightOutcome } from '../lib/types';

/** The demo's three sources, pre-ticked when they are in this publisher's catalog. */
// AG Grid and AG Charts load only when the simulator is shown.
const PriceSimulator = lazy(() => import('../components/PriceSimulator'));

const DEFAULT_SELECTION = ['asset_northwind_index_v1', 'asset_okafor_notes_v1', 'asset_kestrel_panel_v1'];
const DEFAULT_GOAL =
  'Create a commercial developer-tools market report using approved sources. Find a compatible replacement if any source fails the license check.';

export function StudioPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: () => api<{ assets: CatalogEntry[] }>('/catalog') });

  const [mode, setMode] = useState<'agent' | 'manual'>('agent');
  // null until the publisher ticks something: then the demo defaults apply, if they exist.
  const [picked, setPicked] = useState<string[] | null>(null);
  const [goal, setGoal] = useState(DEFAULT_GOAL);
  const [autoReplace, setAutoReplace] = useState(false);
  // ---- manual license check
  const [outcome, setOutcome] = useState<PreflightOutcome | null>(null);
  const [intent, setIntent] = useState<BuildIntent>({
    title: 'Developer Tools Market Brief, Q4 2026',
    brief: 'Market intelligence on developer-tools spend, AI coding assistant adoption, developer trust, pricing and licensing concerns, with five findings and an outlook.',
    purpose: 'commercial_report',
    distribution: 'sale',
    includesRawData: false,
    territory: 'US',
    priceCents: 2000,
    currency: 'USD',
  });

  const set = useCallback(<K extends keyof BuildIntent>(k: K, v: BuildIntent[K]) => {
    setOutcome(null);
    setIntent((i) => ({ ...i, [k]: v }));
  }, []);
  const applyPrice = useCallback((cents: number) => set('priceCents', cents), [set]);

  const titles = useMemo(
    () => Object.fromEntries((catalog.data?.assets ?? []).map((a) => [a.assetVersionId, a.assetTitle])),
    [catalog.data],
  );
  // Only what the catalog shows can be selected: a source that was archived, or a version
  // replaced by a newer one, must not stay selected (and built) without a visible tick.
  const selection = useMemo(() => (picked ?? DEFAULT_SELECTION).filter((id) => id in titles), [picked, titles]);

  const preflight = useMutation({
    mutationFn: () => post<PreflightOutcome>('/builds/preflight', { intent, assetVersionIds: selection }),
    onSuccess: (o) => {
      setOutcome(o);
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
  const explain = useQuery({
    queryKey: ['explain', outcome?.buildId],
    queryFn: () => api<Explanation>(`/builds/${outcome!.buildId}/explain`),
    enabled: Boolean(outcome && outcome.report.verdict === 'block'),
  });
  const generate = useMutation({
    mutationFn: () => post<{ artifactId: string | null; citationReport: { errors: Array<{ message: string }> } }>(`/builds/${outcome!.buildId}/generate`),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['artifacts'] });
      if (r.artifactId) navigate(`/reports/${r.artifactId}`);
    },
  });

  // ---- agent
  const [runId, setRunId] = useState<string | null>(null);
  // Coming back to the page (e.g. from the dashboard), reopen a run that still needs attention.
  const openRun = useQuery({
    queryKey: ['agent-runs'],
    queryFn: () => api<{ runs: Array<{ id: string; status: string }> }>('/agent/runs'),
    select: (d) => d.runs.find((r) => r.status === 'awaiting_approval' || r.status === 'running')?.id ?? null,
  });
  useEffect(() => {
    if (!runId && openRun.data) setRunId(openRun.data);
  }, [openRun.data, runId]);
  const start = useMutation({
    mutationFn: () => post<{ runId: string }>('/agent/runs', { goal, intent, assetVersionIds: selection, autoReplace }),
    onSuccess: (r) => setRunId(r.runId),
  });
  // Polls that failed in a row (TanStack resets its own count at every new fetch).
  const pollFailures = useRef(0);
  useEffect(() => {
    pollFailures.current = 0;
  }, [runId]);
  const run = useQuery({
    queryKey: ['agent-run', runId],
    queryFn: async () => {
      try {
        const r = await api<{ run: AgentRun }>(`/agent/runs/${runId}`);
        pollFailures.current = 0;
        return r;
      } catch (e) {
        pollFailures.current += 1;
        throw e;
      }
    },
    enabled: Boolean(runId),
    retry: false,
    // Fast while the agent works, slow while it waits for the publisher. A failed poll (a
    // brief outage, a rate limit) backs off and tries again; a run that's gone (e.g. after a
    // demo reset), five failures in a row, or a finished run stop it.
    refetchInterval: (q) => {
      if (q.state.status === 'error') {
        const gone = q.state.error instanceof ApiError && q.state.error.status === 404;
        return gone || pollFailures.current >= 5 ? false : Math.min(15_000, 1000 * 2 ** pollFailures.current);
      }
      const status = q.state.data?.run.status;
      if (status === 'completed' || status === 'failed') return false;
      return status === 'awaiting_approval' ? 3000 : 800;
    },
  });
  // A decision stays "made" until the run moves on, so a second click can't send another.
  const [decidedAt, setDecidedAt] = useState<string | null>(null);
  const runKey = run.data ? `${run.data.run.id}:${run.data.run.status}:${run.data.run.steps.length}` : null;
  const decide = useMutation({
    mutationFn: (approved: boolean) => post(`/agent/runs/${runId}/decision`, { approved }),
    onSuccess: () => {
      setDecidedAt(runKey);
      qc.invalidateQueries({ queryKey: ['agent-run', runId] });
    },
  });
  const stop = useMutation({
    mutationFn: () => post(`/agent/runs/${runId}/cancel`),
    onSettled: () => qc.invalidateQueries({ queryKey: ['agent-run', runId] }),
  });

  if (catalog.error && !catalog.data) return <ErrorNote error={catalog.error} />;
  if (!catalog.data) return <Spinner />;
  const assets = catalog.data.assets;

  const toggle = (id: string) => {
    setOutcome(null);
    setPicked(selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id]);
  };
  // Chosen sources whose license won't allow a report that's sold: say so before the check does.
  const internalOnly = intent.distribution === 'sale' ? assets.filter((a) => selection.includes(a.assetVersionId) && a.license && !a.license.terms.commercialUse) : [];
  const field = 'h-9 w-full min-w-0 rounded-lg border border-line px-3';

  return (
    <>
      <PageHeader
        title="Create a report"
        subtitle="Describe the report and pick licensed sources. A license check decides what can be written; the research assistant can only work within that decision."
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="min-w-0 space-y-6">
          <Card title="1 · The report">
            <div className="grid gap-3 text-sm">
              <label className="grid min-w-0 gap-1">
                <span className="text-muted">Title</span>
                <input className={field} value={intent.title} onChange={(e) => set('title', e.target.value)} />
              </label>
              <label className="grid min-w-0 gap-1">
                <span className="text-muted">What it should cover</span>
                <textarea className="min-h-20 w-full min-w-0 rounded-lg border border-line px-3 py-2" value={intent.brief} onChange={(e) => set('brief', e.target.value)} />
              </label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="grid min-w-0 content-start gap-1">
                  <span className="text-muted">What it’s for</span>
                  <select className={clsx(field, 'px-2')} value={intent.purpose} onChange={(e) => set('purpose', e.target.value as BuildIntent['purpose'])}>
                    <option value="commercial_report">A report to sell</option>
                    <option value="internal_research">Internal research</option>
                  </select>
                </label>
                <label className="grid min-w-0 content-start gap-1">
                  <span className="text-muted">Who gets it</span>
                  <select className={clsx(field, 'px-2')} value={intent.distribution} onChange={(e) => set('distribution', e.target.value as BuildIntent['distribution'])}>
                    <option value="sale">Buyers, who pay for it</option>
                    <option value="internal">Only my team</option>
                  </select>
                </label>
                <label className="grid min-w-0 content-start gap-1">
                  <span className="text-muted">Price (USD)</span>
                  <DraftInput
                    inputMode="decimal"
                    className={field}
                    value={(intent.priceCents / 100).toFixed(2)}
                    onCommit={(text) => {
                      const cents = parseDollars(text);
                      if (cents !== null && cents <= 1_000_000) set('priceCents', cents);
                    }}
                  />
                </label>
                <label className="grid min-w-0 content-start gap-1">
                  <span className="text-muted">Country it’s sold in</span>
                  <input
                    className={clsx(field, 'uppercase')}
                    maxLength={2}
                    aria-describedby="territory-hint"
                    value={intent.territory}
                    onChange={(e) => set('territory', e.target.value.toUpperCase())}
                  />
                  <span id="territory-hint" className="text-xs text-muted">
                    {/^[A-Z]{2}$/.test(intent.territory) ? describeTerritory(intent.territory) : 'Two-letter country code, like US or GB'}
                  </span>
                </label>
              </div>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5" checked={intent.includesRawData} onChange={(e) => set('includesRawData', e.target.checked)} />
                <span>Include the original source data in an appendix (some licenses don’t allow this)</span>
              </label>
            </div>
          </Card>

          <Card title="2 · Licensed sources" action={<span className="text-xs text-muted">{selection.length} chosen</span>}>
            {internalOnly.length > 0 && (
              <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <strong>{internalOnly.map((a) => a.assetTitle).join(', ')}</strong> {internalOnly.length === 1 ? 'is' : 'are'} licensed for internal research only, so the license check will stop a report that’s sold.{' '}
                {mode === 'agent'
                  ? 'Start the assistant and it will find a replacement for you to approve, or untick it and choose another source.'
                  : 'Untick it and choose another source, such as one marked “Can be sold”.'}
              </p>
            )}
            <ul className="space-y-2">
              {assets.map((a) => {
                const t = a.license?.terms;
                const checked = selection.includes(a.assetVersionId);
                return (
                  <li key={a.assetVersionId}>
                    <label className={clsx('flex cursor-pointer gap-3 rounded-lg border p-3', checked ? 'border-ink bg-slate-50' : 'border-line hover:bg-slate-50')}>
                      <input type="checkbox" className="mt-1" checked={checked} onChange={() => toggle(a.assetVersionId)} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="min-w-0 font-medium">{a.assetTitle}</span>
                          <span className="text-xs text-muted">{a.owner.name}</span>
                        </div>
                        {t && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            <Badge tone={t.commercialUse ? 'pass' : 'block'}>{t.commercialUse ? 'Can be sold' : 'Internal research only'}</Badge>
                            <Badge>{economicsLabel(t.economics)}</Badge>
                            {t.derivativeReports === 'allowed_with_attribution' && <Badge tone="warn">Needs a credit line</Badge>}
                            {t.payableOn === 'cited_in_output' && <Badge tone="ai">Paid only if cited</Badge>}
                            {!t.rawRedistribution && <Badge>Original data can’t be shared</Badge>}
                            {t.validUntil && t.validUntil < new Date().toISOString().slice(0, 10) && <Badge tone="block">Ended {formatDay(t.validUntil)}</Badge>}
                          </div>
                        )}
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          </Card>

        </div>

        {/* Stays in view beside the long form on wide screens; scrolls on its own if taller than the window. */}
        <div className="min-w-0 space-y-6 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-y-auto">
          <div className="grid w-full grid-cols-2 gap-1 rounded-lg border border-line bg-white p-1 text-sm sm:inline-flex sm:w-auto">
            <button type="button" aria-pressed={mode === 'agent'} className={clsx('flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-center sm:whitespace-nowrap', mode === 'agent' ? 'bg-ink text-white' : 'text-muted hover:text-ink')} onClick={() => setMode('agent')}>
              <Bot className="size-4" /> Research assistant
            </button>
            <button type="button" aria-pressed={mode === 'manual'} className={clsx('flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-center sm:whitespace-nowrap', mode === 'manual' ? 'bg-ink text-white' : 'text-muted hover:text-ink')} onClick={() => setMode('manual')}>
              <ListChecks className="size-4" /> Check licenses myself
            </button>
          </div>

          {mode === 'agent' ? (
            <Card title="3 · Tell the assistant what you need">
              <textarea aria-label="What the assistant should do" className="min-h-20 w-full rounded-lg border border-line px-3 py-2 text-sm" value={goal} onChange={(e) => setGoal(e.target.value)} />
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={autoReplace} onChange={(e) => setAutoReplace(e.target.checked)} />
                Let it swap in another source that fits the licenses without asking me first
              </label>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button loading={start.isPending} disabled={selection.length === 0} onClick={() => start.mutate()}>
                  <Sparkles className="size-4" /> Start the assistant
                </Button>
                <span className="text-xs text-muted">The assistant can’t change the price or purpose, get past a failed license check, or move money.</span>
              </div>
              <ErrorNote error={start.error} />
              {run.error && !run.data && <ErrorNote error={run.error} />}
              {run.data && (
                <div className="mt-5 border-t border-line pt-5">
                  {run.error && (
                    <p role="status" className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                      {!(run.error instanceof ApiError && run.error.status === 404) && pollFailures.current < 5
                        ? 'Lost touch with the assistant for a moment. Trying again…'
                        : 'Couldn’t load the assistant’s latest progress. Reload the page to try again.'}
                    </p>
                  )}
                  <AgentTrace
                    run={run.data.run}
                    titles={titles}
                    onDecide={(a) => decide.mutate(a)}
                    deciding={decide.isPending || decidedAt === runKey}
                    onStop={() => stop.mutate()}
                    stopping={stop.isPending}
                  />
                  <ErrorNote error={decide.error ?? stop.error} />
                </div>
              )}
            </Card>
          ) : (
            <Card
              title="3 · License check"
              action={
                <Button size="sm" loading={preflight.isPending} disabled={selection.length === 0} onClick={() => preflight.mutate()}>
                  Run the license check
                </Button>
              }
            >
              <ErrorNote error={preflight.error} />
              {!outcome ? (
                <p className="text-sm text-muted">Run the license check to see whether every chosen source may be used for this report.</p>
              ) : (
                <div className="space-y-4">
                  <PreflightMatrix report={outcome.report} titles={titles} />
                  {/* The failed checks are listed above; add only what's new: Gemini's summary, and what to do. */}
                  {explain.data?.source === 'vertex' ? (
                    <div className="rounded-lg border border-line bg-slate-50 p-4 text-sm">
                      <div className="flex flex-wrap items-center gap-2 font-medium">
                        {explain.data.headline}
                        <Badge tone="ai">Explained by Gemini</Badge>
                      </div>
                      <p className="mt-1 text-slate-700">{explain.data.explanation}</p>
                      {explain.data.suggestedFix && <p className="mt-1 text-muted">What to do: {explain.data.suggestedFix}</p>}
                    </div>
                  ) : (
                    explain.data?.suggestedFix && <p className="text-sm text-slate-700"><span className="font-medium">What to do:</span> {explain.data.suggestedFix}</p>
                  )}
                  {outcome.report.verdict === 'pass' && (
                    <div className="flex flex-wrap items-center gap-3">
                      <Button loading={generate.isPending} onClick={() => generate.mutate()}>
                        Write the report
                      </Button>
                      <span className="text-xs text-muted">It can only draw on the exact versions of the sources checked above.</span>
                    </div>
                  )}
                  {generate.data && !generate.data.artifactId && (
                    <ErrorNote error={new Error(`The draft was rejected because its citations didn’t check out: ${generate.data.citationReport.errors.map((e) => e.message).join(' ')}`)} />
                  )}
                  <ErrorNote error={generate.error} />
                </div>
              )}
            </Card>
          )}
        </div>
      </div>

      {intent.distribution === 'sale' && (
        <div className="mt-6">
          <Suspense fallback={<Spinner />}>
            <PriceSimulator
              sources={assets.filter((a) => selection.includes(a.assetVersionId))}
              priceCents={intent.priceCents}
              onUsePrice={applyPrice}
            />
          </Suspense>
        </div>
      )}
    </>
  );
}
