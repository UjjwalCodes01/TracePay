import type { PreflightReport, RuleId, RuleResult } from '@tracepay/shared';
import clsx from 'clsx';
import { Check, Minus, PenLine, X } from 'lucide-react';
import { formatMoney } from '../lib/format';
import { Badge } from './ui';

const SOURCE_RULES: Array<{ id: RuleId; label: string }> = [
  { id: 'LICENSE_APPROVED', label: 'Approved' },
  { id: 'LICENSE_IN_TERM', label: 'In term' },
  { id: 'PURPOSE_ALLOWED', label: 'Purpose' },
  { id: 'COMMERCIAL_USE', label: 'Commercial' },
  { id: 'DERIVATIVE_ALLOWED', label: 'Derivative' },
  { id: 'RAW_REDISTRIBUTION', label: 'Raw data' },
  { id: 'TERRITORY', label: 'Territory' },
  { id: 'PAYEE_DEFINED', label: 'Payee' },
  { id: 'ATTRIBUTION', label: 'Attribution' },
];

function Cell({ r }: { r: RuleResult | undefined }) {
  if (!r) return <Minus className="mx-auto size-4 text-slate-300" />;
  const icon = {
    pass: <Check className="mx-auto size-4 text-pass" />,
    fail: <X className="mx-auto size-4 text-block" />,
    skip: <Minus className="mx-auto size-4 text-slate-300" />,
    obligation: <PenLine className="mx-auto size-4 text-contract" />,
  }[r.outcome];
  return <span title={r.message}>{icon}</span>;
}

export function PreflightMatrix({ report, titles }: { report: PreflightReport; titles: Record<string, string> }) {
  const sourceIds = [...new Set(report.results.flatMap((r) => (r.assetVersionId ? [r.assetVersionId] : [])))];
  const find = (id: string, rule: RuleId) => report.results.find((r) => r.assetVersionId === id && r.ruleId === rule);
  const missing = (id: string) => find(id, 'LICENSE_PRESENT')?.outcome === 'fail';
  const failures = report.results.filter((r) => r.outcome === 'fail');
  const buildRules = report.results.filter((r) => !r.assetVersionId);

  return (
    <div className="space-y-4">
      <div
        className={clsx(
          'flex items-center justify-between rounded-lg px-4 py-3 text-sm font-medium',
          report.verdict === 'pass' ? 'bg-verified-soft text-verified' : 'bg-block-soft text-block',
        )}
      >
        <span>{report.verdict === 'pass' ? 'PASS — every source is licensed for this deliverable' : `BLOCK — ${failures.length} rule${failures.length === 1 ? '' : 's'} failed`}</span>
        <span className="mono opacity-70">{report.policyVersion}</span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-muted">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Source</th>
              {SOURCE_RULES.map((r) => (
                <th key={r.id} className="px-2 py-2 text-center font-medium" title={r.id}>
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
                  <td className="max-w-[14rem] truncate px-3 py-2 font-medium" title={titles[id] ?? id}>
                    {titles[id] ?? id}
                  </td>
                  {missing(id) ? (
                    <td colSpan={SOURCE_RULES.length} className="px-3 py-2 text-block">No license grant</td>
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
                <span className="mono mr-1.5 rounded bg-red-100 px-1">{f.ruleId}</span>
                {f.message}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2 text-xs">
        {buildRules.map((r) => (
          <Badge key={r.ruleId} tone={r.outcome === 'fail' ? 'block' : r.outcome === 'pass' ? 'pass' : 'neutral'}>
            {r.ruleId}: {r.message}
          </Badge>
        ))}
        <Badge tone="info">Publisher keeps at least {formatMoney(report.economics.minPublisherResidualCents)}</Badge>
      </div>

      {report.obligations.length > 0 && (
        <p className="text-sm text-contract">
          <PenLine className="mr-1 inline size-4" />
          Attribution that will be added to the report automatically: {report.obligations.map((o) => `“${o.text}”`).join(', ')}
        </p>
      )}
    </div>
  );
}
