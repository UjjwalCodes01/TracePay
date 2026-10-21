import type { BuildIntent } from '@tracepay/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Bot, ListChecks, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { AgentTrace } from '../components/AgentTrace';
import { DraftInput, parseDollars } from '../components/DraftInput';
import { PreflightMatrix } from '../components/PreflightMatrix';
import { Badge, Button, Card, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { api, post } from '../lib/api';
import { economicsLabel } from '../lib/format';
import type { AgentRun, CatalogEntry, Explanation, PreflightOutcome } from '../lib/types';

/** The demo's three sources, pre-ticked when they are in this publisher's catalog. */
const DEFAULT_SELECTION = ['asset_northwind_index_v1', 'asset_okafor_notes_v1', 'asset_kestrel_panel_v1'];
const DEFAULT_GOAL =
  'Create a commercial developer-tools market report using approved sources. Find a compatible replacement if any source fails licensing checks.';

export function StudioPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: () => api<{ assets: CatalogEntry[] }>('/catalog') });

  const [mode, setMode] = useState<'agent' | 'manual'>('agent');
  // null until the publisher ticks something: then the demo defaults apply, if they exist.
  const [picked, setPicked] = useState<string[] | null>(null);
  const [goal, setGoal] = useState(DEFAULT_GOAL);
  const [autoReplace, setAutoReplace] = useState(false);
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

  const titles = useMemo(
    () => Object.fromEntries((catalog.data?.assets ?? []).map((a) => [a.assetVersionId, a.assetTitle])),
    [catalog.data],
  );
  // Only what the catalog shows can be selected: a source that was archived, or a version
  // replaced by a newer one, must not stay selected (and built) without a visible tick.
  const selection = useMemo(() => (picked ?? DEFAULT_SELECTION).filter((id) => id in titles), [picked, titles]);

  // ---- manual preflight
  const [outcome, setOutcome] = useState<PreflightOutcome | null>(null);
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
  const run = useQuery({
    queryKey: ['agent-run', runId],
    queryFn: () => api<{ run: AgentRun }>(`/agent/runs/${runId}`),
    enabled: Boolean(runId),
    retry: false,
    // Fast while the agent works, slow while it waits for the publisher, and stop on an
    // error (e.g. the run is gone after a demo reset) or when it's finished.
    refetchInterval: (q) => {
      if (q.state.status === 'error') return false;
      const status = q.state.data?.run.status;
      if (status === 'completed' || status === 'failed') return false;
      return status === 'awaiting_approval' ? 3000 : 800;
    },
  });
  const decide = useMutation({
    mutationFn: (approved: boolean) => post(`/agent/runs/${runId}/decision`, { approved }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-run', runId] }),
  });

  if (catalog.isLoading) return <Spinner />;
  if (catalog.error) return <ErrorNote error={catalog.error} />;

  const toggle = (id: string) => {
    setOutcome(null);
    setPicked(selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id]);
  };
  const set = <K extends keyof BuildIntent>(k: K, v: BuildIntent[K]) => {
    setOutcome(null);
    setIntent((i) => ({ ...i, [k]: v }));
  };

  return (
    <>
      <PageHeader
        title="Create a Report"
        subtitle="Describe the deliverable and pick licensed sources. The license compiler decides what can be built; the agent can only work within that decision."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="space-y-6">
          <Card title="1 · Intended deliverable">
            <div className="grid gap-3 text-sm">
              <label className="grid gap-1">
                <span className="text-muted">Title</span>
                <input className="h-9 rounded-lg border border-line px-3" value={intent.title} onChange={(e) => set('title', e.target.value)} />
              </label>
              <label className="grid gap-1">
                <span className="text-muted">Brief</span>
                <textarea className="min-h-20 rounded-lg border border-line px-3 py-2" value={intent.brief} onChange={(e) => set('brief', e.target.value)} />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1">
                  <span className="text-muted">Purpose</span>
                  <select className="h-9 rounded-lg border border-line px-2" value={intent.purpose} onChange={(e) => set('purpose', e.target.value as BuildIntent['purpose'])}>
                    <option value="commercial_report">Commercial report</option>
                    <option value="internal_research">Internal research</option>
                  </select>
                </label>
                <label className="grid gap-1">
                  <span className="text-muted">Distribution</span>
                  <select className="h-9 rounded-lg border border-line px-2" value={intent.distribution} onChange={(e) => set('distribution', e.target.value as BuildIntent['distribution'])}>
                    <option value="sale">Sell</option>
                    <option value="internal">Internal only</option>
                  </select>
                </label>
                <label className="grid gap-1">
                  <span className="text-muted">Price (USD)</span>
                  <DraftInput
                    inputMode="decimal"
                    className="h-9 rounded-lg border border-line px-3"
                    value={(intent.priceCents / 100).toFixed(2)}
                    onCommit={(text) => {
                      const cents = parseDollars(text);
                      if (cents !== null && cents <= 1_000_000) set('priceCents', cents);
                    }}
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-muted">Territory</span>
                  <input className="h-9 rounded-lg border border-line px-3 uppercase" maxLength={2} value={intent.territory} onChange={(e) => set('territory', e.target.value.toUpperCase())} />
                </label>
              </div>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={intent.includesRawData} onChange={(e) => set('includesRawData', e.target.checked)} />
                <span>Include a raw-data appendix (exposes source content)</span>
              </label>
            </div>
          </Card>

          <Card title="2 · Licensed sources" action={<span className="text-xs text-muted">{selection.length} selected</span>}>
            <ul className="space-y-2">
              {catalog.data!.assets.map((a) => {
                const t = a.license?.terms;
                const checked = selection.includes(a.assetVersionId);
                return (
                  <li key={a.assetVersionId}>
                    <label className={clsx('flex cursor-pointer gap-3 rounded-lg border p-3', checked ? 'border-ink bg-slate-50' : 'border-line hover:bg-slate-50')}>
                      <input type="checkbox" className="mt-1" checked={checked} onChange={() => toggle(a.assetVersionId)} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium">{a.assetTitle}</span>
                          <span className="text-xs text-muted">{a.owner.name}</span>
                        </div>
                        {t && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            <Badge tone={t.commercialUse ? 'pass' : 'block'}>{t.commercialUse ? 'Commercial OK' : 'Internal only'}</Badge>
                            <Badge>{economicsLabel(t.economics)}</Badge>
                            {t.derivativeReports === 'allowed_with_attribution' && <Badge tone="warn">Attribution</Badge>}
                            {t.payableOn === 'cited_in_output' && <Badge tone="ai">Paid if cited</Badge>}
                            {!t.rawRedistribution && <Badge>No raw redistribution</Badge>}
                            {t.validUntil && t.validUntil < new Date().toISOString().slice(0, 10) && <Badge tone="block">Expired {t.validUntil}</Badge>}
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

        <div className="space-y-6">
          <div className="inline-flex rounded-lg border border-line bg-white p-1 text-sm">
            <button className={clsx('flex items-center gap-1.5 rounded-md px-3 py-1.5', mode === 'agent' && 'bg-ink text-white')} onClick={() => setMode('agent')}>
              <Bot className="size-4" /> Publisher Agent
            </button>
            <button className={clsx('flex items-center gap-1.5 rounded-md px-3 py-1.5', mode === 'manual' && 'bg-ink text-white')} onClick={() => setMode('manual')}>
              <ListChecks className="size-4" /> Manual preflight
            </button>
          </div>

          {mode === 'agent' ? (
            <Card title="3 · Give the agent a goal">
              <textarea aria-label="The agent's goal" className="min-h-20 w-full rounded-lg border border-line px-3 py-2 text-sm" value={goal} onChange={(e) => setGoal(e.target.value)} />
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={autoReplace} onChange={(e) => setAutoReplace(e.target.checked)} />
                Pre-authorise compatible source replacements (otherwise the agent asks first)
              </label>
              <div className="mt-3 flex items-center gap-3">
                <Button loading={start.isPending} disabled={selection.length === 0} onClick={() => start.mutate()}>
                  <Sparkles className="size-4" /> Run agent
                </Button>
                <span className="text-xs text-muted">The agent cannot change price or purpose, override the compiler, or move money.</span>
              </div>
              <ErrorNote error={start.error} />
              {run.error && <ErrorNote error={run.error} />}
              {run.data && (
                <div className="mt-5 border-t border-line pt-5">
                  <AgentTrace run={run.data.run} titles={titles} onDecide={(a) => decide.mutate(a)} deciding={decide.isPending} />
                </div>
              )}
            </Card>
          ) : (
            <Card
              title="3 · License preflight"
              action={
                <Button size="sm" loading={preflight.isPending} disabled={selection.length === 0} onClick={() => preflight.mutate()}>
                  Run preflight
                </Button>
              }
            >
              <ErrorNote error={preflight.error} />
              {!outcome ? (
                <p className="text-sm text-muted">Run the compiler to check every selected source against this deliverable.</p>
              ) : (
                <div className="space-y-4">
                  <PreflightMatrix report={outcome.report} titles={titles} />
                  {explain.data && (
                    <div className="rounded-lg border border-line bg-slate-50 p-4 text-sm">
                      <div className="flex items-center gap-2 font-medium">
                        {explain.data.headline}
                        <Badge tone={explain.data.source === 'vertex' ? 'ai' : 'neutral'}>{explain.data.source === 'vertex' ? 'Explained by Gemini' : 'Compiler messages'}</Badge>
                      </div>
                      <p className="mt-1 text-slate-700">{explain.data.explanation}</p>
                      {explain.data.suggestedFix && <p className="mt-1 text-muted">Fix: {explain.data.suggestedFix}</p>}
                    </div>
                  )}
                  {outcome.report.verdict === 'pass' && (
                    <div className="flex items-center gap-3">
                      <Button loading={generate.isPending} onClick={() => generate.mutate()}>
                        Generate report
                      </Button>
                      <span className="text-xs text-muted">Only these pinned source versions can be retrieved.</span>
                    </div>
                  )}
                  {generate.data && !generate.data.artifactId && (
                    <ErrorNote error={new Error(`Citation validation rejected the draft: ${generate.data.citationReport.errors.map((e) => e.message).join(' ')}`)} />
                  )}
                  <ErrorNote error={generate.error} />
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
