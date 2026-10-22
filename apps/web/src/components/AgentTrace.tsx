import { RULE_LABELS, type RuleId } from '@tracepay/shared';
import clsx from 'clsx';
import { AlertTriangle, Bot, CheckCircle2, Hand, Loader2, Wrench } from 'lucide-react';
import { Link } from 'react-router';
import type { AgentRun, AgentStep } from '../lib/types';
import { formatMoney } from '../lib/format';
import { Badge, Button, StatusBadge } from './ui';

const TOOL_LABEL: Record<string, string> = {
  find_approved_sources: 'Look up licensed sources',
  run_license_preflight: 'Check the licenses',
  find_compatible_replacement: 'Look for a source that fits the licenses',
  propose_replacement: 'Suggest a replacement source',
  generate_report: 'Write the report',
  validate_provenance: 'Check where each fact came from',
  prepare_sale: 'Get it ready to sell',
};

/** Why a step was refused, in plain words; the exact code stays in a tooltip. */
const ERROR_LABEL: Record<string, string> = {
  GUARDRAIL: 'Not allowed',
  NOT_FOUND: 'Not found',
  BAD_INPUT: 'Couldn’t do that',
  TOOL_FAILED: 'This step failed',
  UNKNOWN_TOOL: 'Not something it can do',
};

/** The API describes payment for the model ("25% of gross"); people read "of each sale". */
const plainEconomics = (e: string) => (e === 'none' ? 'no payment' : e.replace(/ of gross$/, ' of each sale'));

function ResultSummary({ step, titles }: { step: AgentStep; titles: Record<string, string> }) {
  const o = step.output ?? {};
  const t = (id: unknown) => titles[String(id)] ?? String(id);
  if (o.error) {
    const code = String(o.error);
    return (
      <span className="text-block" title={code}>
        {ERROR_LABEL[code] ?? 'This step failed'}{o.message ? `: ${withTitles(String(o.message), titles)}` : ''}
      </span>
    );
  }
  switch (step.tool) {
    case 'run_license_preflight': {
      const failed = (o.failedRules as Array<{ ruleId: string; assetVersionId: string | null; message: string }>) ?? [];
      return (
        <div className="space-y-1">
          <StatusBadge status={String(o.verdict)} />
          {failed.map((f, i) => (
            <div key={i} className="text-block">
              <span className="font-medium" title={f.ruleId}>{RULE_LABELS[f.ruleId as RuleId] ?? f.ruleId}</span> — {withTitles(f.message, titles)}
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
            <li key={x.assetVersionId} className={x.compatible ? 'text-pass' : 'text-slate-600'}>
              <span aria-hidden>{x.compatible ? '✓' : '✗'}</span> <span className="sr-only">{x.compatible ? 'Fits:' : 'Doesn’t fit:'}</span> <span className={x.compatible ? 'font-medium' : undefined}>{x.title}</span>
              {x.economics && <span className="text-muted"> · {plainEconomics(x.economics)}</span>}
              {!x.compatible && x.reasons[0] && <span className="block pl-4 text-muted">{withTitles(x.reasons[0], titles)}</span>}
            </li>
          ))}
        </ul>
      );
    }
    case 'propose_replacement':
      return o.approved ? (
        <span className="text-pass">{o.by === 'policy' ? 'Approved automatically, as you allowed' : 'Approved by you'}</span>
      ) : (
        <span className="text-block">{o.by === 'publisher' ? 'You declined this replacement.' : String(o.message ?? 'Declined')}</span>
      );
    case 'generate_report':
      return o.artifactId ? (
        <span>
          Report written · citations {o.citationsValid ? 'check out' : 'don’t check out'} · {o.fromFixture ? 'written without AI' : `written by ${String(o.model)}`}{' '}
          <Link className="font-medium text-brand underline" to={`/reports/${String(o.artifactId)}`}>
            open
          </Link>
        </span>
      ) : (
        <span className="text-block">Draft rejected: {((o.citationErrors as string[] | undefined) ?? []).join(' ') || 'its citations didn’t check out.'}</span>
      );
    case 'validate_provenance':
      return (
        <span>
          {Number(o.citations ?? 0)} citation{Number(o.citations) === 1 ? '' : 's'} · cites: {((o.citedAssetVersionIds as string[] | undefined) ?? []).map(t).join(', ') || 'none'}
          {((o.retrievedNotCitedAssetVersionIds as string[] | undefined) ?? []).length > 0 &&
            ` · read but not cited: ${(o.retrievedNotCitedAssetVersionIds as string[]).map(t).join(', ')}`}
        </span>
      );
    case 'prepare_sale':
      return (
        <span>
          {o.listed ? 'For sale' : 'Not for sale yet'}
          {Number.isFinite(Number(o.priceCents)) && ` · ${formatMoney(Number(o.priceCents))}`} · paid with PayPal (sandbox)
        </span>
      );
    case 'find_approved_sources':
      return <span>{((o.sources as unknown[] | undefined) ?? []).length} licensed sources found</span>;
    default:
      return (
        <details>
          <summary className="cursor-pointer text-muted">Technical details</summary>
          <pre className="mono mt-1 whitespace-pre-wrap">{JSON.stringify(o, null, 2)}</pre>
        </details>
      );
  }
}

/** Agents (and models) refer to sources by id and use the API's terms; show titles and everyday words. */
function withTitles(text: string, titles: Record<string, string>) {
  return plainWords(Object.entries(titles).reduce((t, [id, title]) => t.split(id).join(`"${title}"`), text));
}

function plainWords(text: string) {
  return text
    .replace(/\bpreflight(?:ed)?\b/gi, (m) => (m[0] === 'P' ? 'License check' : 'license check'))
    .replace(/\bbuild-level\b/gi, 'report-wide')
    .replace(/\bof gross\b/gi, 'of each sale')
    .replace(/\bartifact\b/gi, 'report');
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
  onStop,
  stopping,
}: {
  run: AgentRun;
  titles: Record<string, string>;
  onDecide: (approved: boolean) => void;
  deciding: boolean;
  /** Stops a run that is working or waiting for a decision. */
  onStop?: () => void;
  stopping?: boolean;
}) {
  const steps = run.steps.filter((s) => s.kind !== 'approval_request');
  const artifactId = run.builds.find((b) => b.artifact)?.artifact?.id;
  // run.model is "<planner>:<model>", e.g. "gemini:gemini-flash-latest" or "rule-based:rule-based-planner/1".
  const planner = run.model.startsWith('gemini') ? `Planned by Gemini (${run.model.slice(run.model.indexOf(':') + 1)})` : 'Planned by fixed rules (no AI model configured)';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <Bot className="size-4" aria-hidden /> Research assistant
          <Badge tone={run.model.startsWith('gemini') ? 'ai' : 'warn'}>{planner}</Badge>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge status={run.status} />
          {onStop && (run.status === 'running' || run.status === 'awaiting_approval') && (
            <Button size="sm" variant="secondary" loading={stopping} onClick={onStop}>
              Stop
            </Button>
          )}
        </div>
      </div>

      {/* New steps are read out as they arrive. */}
      <ol className="relative space-y-2 border-l border-line pl-5" aria-live="polite" aria-relevant="additions" aria-label="What the assistant did">
        {steps.map((s) => (
          <li key={s.id} className="relative min-w-0 text-sm">
            {/* One dot per step, on the line and level with the step's first line; a result hangs off its step. */}
            {s.kind !== 'tool_result' && (
              <span
                aria-hidden
                className={clsx('absolute -left-[27px] size-3.5 rounded-full border border-line bg-white', s.kind === 'plan' || s.kind === 'message' ? 'top-[11px]' : 'top-[3px]')}
              />
            )}
            {s.kind === 'plan' || s.kind === 'message' ? (
              <p className={clsx('rounded-lg px-3 py-2', s.kind === 'message' ? 'bg-slate-900 text-white' : 'bg-slate-50 text-slate-700')}>{withTitles(String(s.output?.text ?? ''), titles)}</p>
            ) : s.kind === 'tool_call' ? (
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-slate-700">
                <Wrench className="size-3.5 shrink-0 self-center text-muted" aria-hidden />
                <span className="font-medium" title={s.tool ?? undefined}>
                  {TOOL_LABEL[s.tool ?? ''] ?? (s.tool ?? 'Step').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}
                </span>
                {argsSummary(s, titles) && <span className="min-w-0 break-words text-muted">{argsSummary(s, titles)}</span>}
              </div>
            ) : s.kind === 'tool_result' ? (
              <div className="ml-5 min-w-0 rounded-lg border border-line bg-white px-3 py-2 text-[13px] leading-5">
                <ResultSummary step={s} titles={titles} />
              </div>
            ) : (
              <p className="flex items-center gap-1.5 text-block">
                <AlertTriangle className="size-4 shrink-0" aria-hidden /> {withTitles(String(s.output?.message ?? 'The assistant stopped at this step.'), titles)}
              </p>
            )}
          </li>
        ))}
        {run.status === 'running' && (
          <li className="flex items-center gap-2 text-sm text-muted">
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> Working…
          </li>
        )}
      </ol>

      {run.status === 'awaiting_approval' && run.pending && (
        <div className="rounded-xl border border-contract/40 bg-contract-soft p-4">
          <div className="flex items-center gap-2 font-medium text-contract">
            <Hand className="size-4" /> The assistant needs your approval
          </div>
          <p className="mt-2 text-sm">
            Replace <strong>{titles[run.pending.blockedAssetVersionId] ?? run.pending.blockedAssetVersionId}</strong> with{' '}
            <strong>{titles[run.pending.replacementAssetVersionId] ?? run.pending.replacementAssetVersionId}</strong>?
          </p>
          <p className="mt-1 text-sm text-slate-700">{withTitles(run.pending.reason, titles)}</p>
          <div className="mt-3 flex flex-wrap gap-2">
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
          <CheckCircle2 className="size-4" /> The report is ready. Open it
        </Link>
      )}
    </div>
  );
}
