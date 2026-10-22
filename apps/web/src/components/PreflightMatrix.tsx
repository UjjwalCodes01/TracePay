import type { PreflightReport, RuleId, RuleOutcome, RuleResult } from '@tracepay/shared';
import { RULE_LABELS } from '@tracepay/shared';
import clsx from 'clsx';
import { Check, Minus, PenLine, X } from 'lucide-react';
import { formatMoney } from '../lib/format';
import { Badge, TechnicalDetails } from './ui';

const SOURCE_RULES: Array<{ id: RuleId; label: string }> = [
  { id: 'LICENSE_APPROVED', label: 'Agreed' },
  { id: 'LICENSE_IN_TERM', label: 'Current' },
  { id: 'PURPOSE_ALLOWED', label: 'This use' },
  { id: 'COMMERCIAL_USE', label: 'For sale' },
  { id: 'DERIVATIVE_ALLOWED', label: 'Reports' },
  { id: 'RAW_REDISTRIBUTION', label: 'Original data' },
  { id: 'TERRITORY', label: 'Country' },
  { id: 'PAYEE_DEFINED', label: 'Can be paid' },
  { id: 'ATTRIBUTION', label: 'Credit' },
];

const OUTCOME: Record<RuleOutcome, string> = { pass: 'OK', fail: 'Blocked', skip: 'Doesn’t apply', obligation: 'Credit required' };

function Cell({ r }: { r: RuleResult | undefined }) {
  if (!r) return <Minus className="mx-auto size-4 text-slate-300" />;
  const icon = {
    pass: <Check className="mx-auto size-4 text-pass" />,
    fail: <X className="mx-auto size-4 text-block" />,
    skip: <Minus className="mx-auto size-4 text-slate-300" />,
    obligation: <PenLine className="mx-auto size-4 text-contract" />,
  }[r.outcome];
  return (
    <span title={`${OUTCOME[r.outcome]}: ${r.message}`}>
      {icon}
      <span className="sr-only">{OUTCOME[r.outcome]}</span>
    </span>
  );
}

export function PreflightMatrix({ report, titles }: { report: PreflightReport; titles: Record<string, string> }) {
  const sourceIds = [...new Set(report.results.flatMap((r) => (r.assetVersionId ? [r.assetVersionId] : [])))];
  const find = (id: string, rule: RuleId) => report.results.find((r) => r.assetVersionId === id && r.ruleId === rule);
  const missing = (id: string) => find(id, 'LICENSE_PRESENT')?.outcome === 'fail';
  const failures = report.results.filter((r) => r.outcome === 'fail');
  // Failed build-level checks are explained in the list below; the rest are just ✓ chips.
  const buildRules = report.results.filter((r) => !r.assetVersionId && r.outcome !== 'fail');

  return (
    <div className="min-w-0 space-y-4">
      <div
        role="status"
        className={clsx(
          'flex items-center justify-between rounded-lg px-4 py-3 text-sm font-medium',
          report.verdict === 'pass' ? 'bg-verified-soft text-verified' : 'bg-block-soft text-block',
        )}
      >
        <span>
          {report.verdict === 'pass'
            ? 'Licenses check out: every source is licensed for this report'
            : `Stopped: ${failures.length} license check${failures.length === 1 ? '' : 's'} failed`}
        </span>
      </div>

      {/* Scrolls sideways inside the card on narrow screens rather than widening the page. */}
      <div className="max-w-full overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-muted">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Source</th>
              {SOURCE_RULES.map((r) => (
                <th key={r.id} className="whitespace-nowrap px-2 py-2 text-center font-medium" title={RULE_LABELS[r.id]}>
                  {r.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {sourceIds.map((id) => {
              const blocked = report.results.some((r) => r.assetVersionId === id && r.outcome === 'fail');
              return (
                <tr key={id} className={clsx(blocked && 'bg-red-50/60')}>
                  <td className="min-w-[9rem] max-w-[14rem] truncate px-3 py-2 font-medium" title={titles[id] ?? id}>
                    {titles[id] ?? id}
                  </td>
                  {missing(id) ? (
                    <td colSpan={SOURCE_RULES.length} className="px-3 py-2 text-block">Not licensed to you</td>
                  ) : (
                    SOURCE_RULES.map((r) => (
                      <td key={r.id} className="px-2 py-2 text-center">
                        <Cell r={find(id, r.id)} />
                      </td>
                    ))
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {failures.length > 0 && (
        <ul className="space-y-1.5 text-sm">
          {failures.map((f, i) => (
            <li key={i} className="flex gap-2 text-block">
              <X className="mt-0.5 size-4 shrink-0" />
              <span>
                <span className="mr-1.5 rounded bg-red-100 px-1 font-medium" title={f.ruleId}>{RULE_LABELS[f.ruleId] ?? f.ruleId}</span>
                {f.message}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2 text-xs">
        {buildRules.map((r) => (
          <span key={r.ruleId} title={r.message}>
            <Badge tone={r.outcome === 'pass' ? 'pass' : 'neutral'}>
              {r.outcome === 'pass' ? <Check className="size-3" aria-hidden /> : <Minus className="size-3" aria-hidden />}
              {RULE_LABELS[r.ruleId] ?? r.ruleId}
              <span className="sr-only">: {r.message}</span>
            </Badge>
          </span>
        ))}
        <Badge tone="info">You keep at least {formatMoney(report.economics.minPublisherResidualCents)} of each sale</Badge>
      </div>

      {report.obligations.length > 0 && (
        <p className="text-sm text-contract">
          <PenLine className="mr-1 inline size-4" />
          Credit lines added to the report automatically: {report.obligations.map((o) => `“${o.text}”`).join(', ')}
        </p>
      )}

      <TechnicalDetails className="mt-0 text-xs">
        <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-y-1 text-muted">
          <dt>Rules version</dt>
          <dd className="mono">{report.policyVersion}</dd>
          {failures.length > 0 && (
            <>
              <dt>Failed rules</dt>
              <dd className="mono break-all">{[...new Set(failures.map((f) => f.ruleId))].join(', ')}</dd>
            </>
          )}
        </dl>
      </TechnicalDetails>
    </div>
  );
}
