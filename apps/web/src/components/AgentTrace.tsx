import clsx from 'clsx';
import { AlertTriangle, Bot, CheckCircle2, Hand, Loader2, Wrench } from 'lucide-react';
import { Link } from 'react-router';
import type { AgentRun, AgentStep } from '../lib/types';
import { Badge, Button, StatusBadge } from './ui';

const TOOL_LABEL: Record<string, string> = {
  find_approved_sources: 'Find approved sources',
  run_license_preflight: 'Run license preflight',
  find_compatible_replacement: 'Find compatible replacement',
  propose_replacement: 'Propose replacement',
  generate_report: 'Generate report',
  validate_provenance: 'Validate provenance',
  prepare_sale: 'Prepare sale',
};

function ResultSummary({ step, titles }: { step: AgentStep; titles: Record<string, string> }) {
  const o = step.output ?? {};
  const t = (id: unknown) => titles[String(id)] ?? String(id);
  if (o.error) return <span className="text-block">{String(o.error)}: {String(o.message)}</span>;
  switch (step.tool) {
    case 'run_license_preflight': {
      const failed = (o.failedRules as Array<{ ruleId: string; assetVersionId: string | null; message: string }>) ?? [];
      return (
        <div className="space-y-1">
          <StatusBadge status={String(o.verdict)} />
          {failed.map((f, i) => (
            <div key={i} className="text-block">
              <span className="mono">{f.ruleId}</span> — {f.message}
            </div>
          ))}
        </div>
      );
    }
    case 'find_compatible_replacement': {
      const c = (o.candidates as Array<{ assetVersionId: string; title: string; compatible: boolean; economics?: string; reasons: string[] }>) ?? [];
      return (
        <ul className="space-y-0.5">
          {c.map((x) => (
            <li key={x.assetVersionId} className={x.compatible ? 'text-pass' : 'text-muted line-through'}>
              {x.compatible ? '✓' : '✗'} {x.title} {x.economics && <span className="text-muted no-underline">· {x.economics}</span>}
              {!x.compatible && x.reasons[0] && <span className="ml-1 text-xs">({x.reasons[0]})</span>}
            </li>
          ))}
        </ul>
      );
    }
    case 'propose_replacement':
      return o.approved ? <span className="text-pass">Approved by {String(o.by)}</span> : <span className="text-block">{String(o.message ?? 'Declined')}</span>;
    case 'generate_report':
      return o.artifactId ? (
        <span>
          Report generated · citations {o.citationsValid ? 'valid' : 'invalid'} · {o.fromFixture ? 'fixture writer' : String(o.model)}{' '}
          <Link className="font-medium text-brand underline" to={`/reports/${String(o.artifactId)}`}>
            open
          </Link>
        </span>
      ) : (
        <span className="text-block">Rejected: {(o.citationErrors as string[])?.join(' ')}</span>
      );
    case 'validate_provenance':
      return (
        <span>
          {String(o.citations)} citations · cited: {(o.citedAssetVersionIds as string[]).map(t).join(', ')}
          {(o.retrievedNotCitedAssetVersionIds as string[]).length > 0 && ` · retrieved but not cited: ${(o.retrievedNotCitedAssetVersionIds as string[]).map(t).join(', ')}`}
        </span>
      );
    case 'prepare_sale':
      return <span>Listed: {o.listed ? 'yes' : 'no'} · ${(Number(o.priceCents) / 100).toFixed(2)} via {String(o.checkout)}</span>;
    case 'find_approved_sources':
      return <span>{(o.sources as unknown[]).length} sources in catalog</span>;
    default:
      return <pre className="mono whitespace-pre-wrap">{JSON.stringify(o)}</pre>;
  }
}

/** Agents (and models) refer to sources by id; show the human title instead. */
function withTitles(text: string, titles: Record<string, string>) {
  return Object.entries(titles).reduce((t, [id, title]) => t.split(id).join(`"${title}"`), text);
}

function argsSummary(step: AgentStep, titles: Record<string, string>) {
  const a = step.input ?? {};
  const t = (id: unknown) => titles[String(id)] ?? String(id);
  if (Array.isArray(a.assetVersionIds)) return (a.assetVersionIds as string[]).map(t).join(' + ');
  if (a.blockedAssetVersionId && a.replacementAssetVersionId) return `${t(a.blockedAssetVersionId)} → ${t(a.replacementAssetVersionId)}`;
  if (a.blockedAssetVersionId) return t(a.blockedAssetVersionId);
  return '';
}

export function AgentTrace({
  run,
  titles,
  onDecide,
  deciding,
}: {
  run: AgentRun;
  titles: Record<string, string>;
  onDecide: (approved: boolean) => void;
  deciding: boolean;
}) {
  const steps = run.steps.filter((s) => s.kind !== 'approval_request');
  const artifactId = run.builds.find((b) => b.artifact)?.artifact?.id;
  // run.model is "<planner>:<model>", e.g. "gemini:gemini-flash-latest" or "rule-based:rule-based-planner/1".
  const planner = run.model.startsWith('gemini') ? `Gemini (${run.model.slice(run.model.indexOf(':') + 1)})` : 'Rule-based planner (no AI model configured)';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <Bot className="size-4" /> Publisher Agent
          <Badge tone={run.model.startsWith('gemini') ? 'ai' : 'warn'}>{planner}</Badge>
        </div>
        <StatusBadge status={run.status} />
      </div>

      <ol className="relative space-y-2 border-l border-line pl-5">
        {steps.map((s) => (
          <li key={s.id} className="relative text-sm">
            <span className="absolute -left-[27px] top-1 flex size-3.5 items-center justify-center rounded-full border border-line bg-white" />
            {s.kind === 'plan' || s.kind === 'message' ? (
              <p className={clsx('rounded-lg px-3 py-2', s.kind === 'message' ? 'bg-slate-900 text-white' : 'bg-slate-50 text-slate-700')}>{withTitles(String(s.output?.text ?? ''), titles)}</p>
            ) : s.kind === 'tool_call' ? (
              <div className="flex items-center gap-2 text-slate-700">
                <Wrench className="size-3.5 shrink-0 text-muted" />
                <span className="shrink-0 whitespace-nowrap font-medium">{TOOL_LABEL[s.tool ?? ''] ?? s.tool}</span>
                <span className="truncate text-muted">{argsSummary(s, titles)}</span>
              </div>
            ) : s.kind === 'tool_result' ? (
              <div className="ml-5 rounded-lg border border-line bg-white px-3 py-2 text-xs">
                <ResultSummary step={s} titles={titles} />
              </div>
            ) : (
              <p className="flex items-center gap-1.5 text-block">
                <AlertTriangle className="size-4" /> {String(s.output?.message ?? 'Error')}
              </p>
            )}
          </li>
        ))}
        {run.status === 'running' && (
          <li className="flex items-center gap-2 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" /> Working…
          </li>
        )}
      </ol>

      {run.status === 'awaiting_approval' && run.pending && (
        <div className="rounded-xl border border-contract/40 bg-contract-soft p-4">
          <div className="flex items-center gap-2 font-medium text-contract">
            <Hand className="size-4" /> The agent needs your approval
          </div>
          <p className="mt-2 text-sm">
            Replace <strong>{titles[run.pending.blockedAssetVersionId] ?? run.pending.blockedAssetVersionId}</strong> with{' '}
            <strong>{titles[run.pending.replacementAssetVersionId] ?? run.pending.replacementAssetVersionId}</strong>?
          </p>
          <p className="mt-1 text-sm text-slate-700">{run.pending.reason}</p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" loading={deciding} onClick={() => onDecide(true)}>
              Approve replacement
            </Button>
            <Button size="sm" variant="secondary" disabled={deciding} onClick={() => onDecide(false)}>
              Decline
            </Button>
          </div>
        </div>
      )}

      {run.status === 'completed' && artifactId && (
        <Link to={`/reports/${artifactId}`} className="flex items-center gap-2 rounded-lg bg-verified-soft px-4 py-3 text-sm font-medium text-verified">
          <CheckCircle2 className="size-4" /> Report ready — open it
        </Link>
      )}
    </div>
  );
}
