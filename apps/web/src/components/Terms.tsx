import type { LicenseTerms } from '@tracepay/shared';
import { describeTerritories, formatBps, formatDay, formatMoney } from '@tracepay/shared';
import clsx from 'clsx';
import { Check, Quote, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { DraftInput, parseDollars } from './DraftInput';
import { Badge } from './ui';

export type TermField =
  | 'commercialUse'
  | 'allowedPurposes'
  | 'derivativeReports'
  | 'attributionText'
  | 'rawRedistribution'
  | 'economics'
  | 'payableOn'
  | 'territories'
  | 'validFrom'
  | 'validUntil'
  | 'aiAnswers';

export interface FieldEvidence {
  field: TermField;
  quote: string | null;
  confidence: 'high' | 'medium' | 'low';
  note?: string;
}

export interface Extraction {
  terms: LicenseTerms;
  evidence: FieldEvidence[];
  warnings: string[];
  source: 'vertex' | 'rules';
  model: string;
}

export function paymentLabel(e: LicenseTerms['economics']): string {
  if (e.kind === 'percent_of_gross') return `${formatBps(e.bps)} of each sale`;
  if (e.kind === 'fixed_per_sale') return `${formatMoney(e.amountCents)} per report sold`;
  return 'No payment';
}

/** A license in plain sentences, for people who will never read JSON. */
export function TermsSummary({ terms, compact }: { terms: LicenseTerms; compact?: boolean }) {
  const rows: Array<{ ok: boolean | null; text: ReactNode }> = [
    { ok: terms.commercialUse, text: terms.commercialUse ? 'Can be used in reports that are sold' : 'Internal research only — not for reports that are sold' },
    {
      ok: terms.derivativeReports !== 'prohibited',
      text:
        terms.derivativeReports === 'prohibited'
          ? 'New reports based on it are not allowed'
          : terms.derivativeReports === 'allowed_with_attribution'
            ? <>Reports must credit: “{terms.attributionText}”</>
            : 'New reports based on it are allowed',
    },
    { ok: terms.rawRedistribution, text: terms.rawRedistribution ? 'Its original data may be shared' : 'Its original data can’t be shared' },
    { ok: null, text: <>Payment: <strong>{paymentLabel(terms.economics)}</strong>{terms.economics.kind !== 'none' && (terms.payableOn === 'cited_in_output' ? ', only when a report actually cites it' : ', whenever a report uses it')}</> },
    {
      ok: !!terms.aiAnswers?.allowed,
      text: terms.aiAnswers?.allowed ? (
        <>
          AI answers may cite it: <strong>{formatMoney(terms.aiAnswers.centsPerCitation)} per cited passage</strong>
        </>
      ) : (
        'AI answers can’t use it'
      ),
    },
    { ok: null, text: terms.territories ? `Only in ${describeTerritories(terms.territories)}` : 'Anywhere in the world' },
    { ok: null, text: terms.validUntil ? `Valid from ${formatDay(terms.validFrom)} until ${formatDay(terms.validUntil)}` : `Valid from ${formatDay(terms.validFrom)}, no end date` },
  ];
  return (
    <ul className={clsx('space-y-1.5', compact ? 'text-xs' : 'text-sm')}>
      {rows.map((r, i) => (
        <li key={i} className="flex items-start gap-2">
          {r.ok === null ? (
            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-slate-400" />
          ) : r.ok ? (
            <Check className="mt-0.5 size-4 shrink-0 text-pass" />
          ) : (
            <X className="mt-0.5 size-4 shrink-0 text-block" />
          )}
          <span>{r.text}</span>
        </li>
      ))}
    </ul>
  );
}

const CONFIDENCE = { high: 'pass', medium: 'warn', low: 'block' } as const;

function Evidence({ e }: { e: FieldEvidence | undefined }) {
  if (!e) return null;
  return (
    <div className="mt-1.5 text-xs">
      {e.quote ? (
        <p className="flex gap-1.5 text-slate-600">
          <Quote className="mt-0.5 size-3 shrink-0" />
          <span className="italic">{e.quote}</span>
        </p>
      ) : (
        <p className="text-muted">Not found in the document.</p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <Badge tone={CONFIDENCE[e.confidence]}>{e.confidence === 'high' ? 'Clearly stated' : e.confidence === 'medium' ? 'Inferred' : 'Assumed — check this'}</Badge>
        {e.note && <span className="text-muted">{e.note}</span>}
      </div>
    </div>
  );
}

const field = 'h-10 w-full rounded-lg border border-line px-3 text-sm focus:border-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/30';

// Top-level so React keeps the same component identity between renders (inputs keep focus).
function EditorRow({ label, evidence, children }: { label: string; evidence: FieldEvidence | undefined; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-line p-4">
      <div className="mb-2 text-sm font-medium">{label}</div>
      {children}
      <Evidence e={evidence} />
    </div>
  );
}

/** Every term as an editable, plain-language question, with the source sentence under it. */
export function TermsEditor({ terms, onChange, evidence = [] }: { terms: LicenseTerms; onChange: (t: LicenseTerms) => void; evidence?: FieldEvidence[] }) {
  const set = <K extends keyof LicenseTerms>(k: K, v: LicenseTerms[K]) => onChange({ ...terms, [k]: v });
  const ev = (f: TermField) => evidence.find((e) => e.field === f);

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <EditorRow label="Can it be used in reports that are sold?" evidence={ev('commercialUse')}>
        <select
          className={field}
          value={terms.commercialUse ? 'yes' : 'no'}
          onChange={(e) => {
            const yes = e.target.value === 'yes';
            onChange({ ...terms, commercialUse: yes, allowedPurposes: yes ? ['internal_research', 'commercial_report'] : ['internal_research'] });
          }}
        >
          <option value="yes">Yes, reports can be sold</option>
          <option value="no">No, internal research only</option>
        </select>
      </EditorRow>

      <EditorRow label="Can new reports be based on it?" evidence={ev('derivativeReports')}>
        <select className={field} value={terms.derivativeReports} onChange={(e) => onChange({ ...terms, derivativeReports: e.target.value as LicenseTerms['derivativeReports'], attributionText: e.target.value === 'allowed_with_attribution' ? terms.attributionText ?? '' : null })}>
          <option value="allowed">Yes</option>
          <option value="allowed_with_attribution">Yes, if they credit me</option>
          <option value="prohibited">No</option>
        </select>
        {terms.derivativeReports === 'allowed_with_attribution' && (
          <input className={clsx(field, 'mt-2')} placeholder="Credit line, e.g. Research by Jane Doe" value={terms.attributionText ?? ''} onChange={(e) => set('attributionText', e.target.value)} />
        )}
      </EditorRow>

      <EditorRow label="How are you paid?" evidence={ev('economics')}>
        <div className="flex gap-2">
          <select
            className={field}
            value={terms.economics.kind}
            onChange={(e) =>
              set(
                'economics',
                e.target.value === 'percent_of_gross'
                  ? { kind: 'percent_of_gross', bps: 1000 }
                  : e.target.value === 'fixed_per_sale'
                    ? { kind: 'fixed_per_sale', amountCents: 100 }
                    : { kind: 'none' },
              )
            }
          >
            <option value="percent_of_gross">A share of each sale</option>
            <option value="fixed_per_sale">A fixed fee per sale</option>
            <option value="none">No payment</option>
          </select>
          {terms.economics.kind === 'percent_of_gross' && (
            <label className="flex items-center gap-1 text-sm">
              <input type="number" min={0} max={100} step={0.5} aria-label="Share of each sale, in percent" className={clsx(field, 'w-24')} value={terms.economics.bps / 100} onChange={(e) => set('economics', { kind: 'percent_of_gross', bps: Math.round(Number(e.target.value) * 100) })} />%
            </label>
          )}
          {terms.economics.kind === 'fixed_per_sale' && (
            <label className="flex items-center gap-1 text-sm">
              $
              <DraftInput
                inputMode="decimal"
                aria-label="Fee per sale in US dollars"
                className={clsx(field, 'w-28')}
                value={(terms.economics.amountCents / 100).toFixed(2)}
                onCommit={(text) => {
                  const cents = parseDollars(text);
                  if (cents !== null) set('economics', { kind: 'fixed_per_sale', amountCents: cents });
                }}
              />
            </label>
          )}
        </div>
      </EditorRow>

      <EditorRow label="When is the payment owed?" evidence={ev('payableOn')}>
        <select className={field} value={terms.payableOn} onChange={(e) => set('payableOn', e.target.value as LicenseTerms['payableOn'])}>
          <option value="included_in_build">Whenever a report uses my source</option>
          <option value="cited_in_output">Only when a report actually cites my source</option>
        </select>
      </EditorRow>

      <EditorRow label="Can AI answers use it? (paid per cited passage)" evidence={ev('aiAnswers')}>
        <select
          className={field}
          value={terms.aiAnswers?.allowed ? 'yes' : 'no'}
          onChange={(e) => set('aiAnswers', e.target.value === 'yes' ? { allowed: true, centsPerCitation: terms.aiAnswers?.centsPerCitation || 2 } : { allowed: false, centsPerCitation: 0 })}
        >
          <option value="no">No</option>
          <option value="yes">Yes, paid for every passage an answer relies on</option>
        </select>
        {terms.aiAnswers?.allowed && (
          <label className="mt-2 flex items-center gap-2 text-sm">
            <DraftInput
              inputMode="decimal"
              className={clsx(field, 'w-24')}
              value={(terms.aiAnswers.centsPerCitation / 100).toFixed(2)}
              onCommit={(text) => {
                const cents = parseDollars(text);
                if (cents !== null && cents <= 500) set('aiAnswers', { allowed: true, centsPerCitation: cents });
              }}
            />
            per cited passage (USD)
          </label>
        )}
      </EditorRow>

      <EditorRow label="Can its original data be shared as is?" evidence={ev('rawRedistribution')}>
        <select className={field} value={terms.rawRedistribution ? 'yes' : 'no'} onChange={(e) => set('rawRedistribution', e.target.value === 'yes')}>
          <option value="no">No</option>
          <option value="yes">Yes</option>
        </select>
      </EditorRow>

      <EditorRow label="Where can it be used?" evidence={ev('territories')}>
        <DraftInput
          className={field}
          placeholder="Anywhere — or country codes like US, GB"
          value={terms.territories?.join(', ') ?? ''}
          onCommit={(text) => {
            const codes = [...new Set(text.toUpperCase().split(/[\s,;]+/).filter((c) => /^[A-Z]{2}$/.test(c)))];
            set('territories', codes.length ? codes : null);
          }}
        />
      </EditorRow>

      <EditorRow label="Starts on" evidence={ev('validFrom')}>
        <input type="date" className={field} value={terms.validFrom} onChange={(e) => set('validFrom', e.target.value)} />
      </EditorRow>

      <EditorRow label="Ends on (leave empty for no end date)" evidence={ev('validUntil')}>
        <input type="date" className={field} value={terms.validUntil ?? ''} onChange={(e) => set('validUntil', e.target.value || null)} />
      </EditorRow>
    </div>
  );
}

export const DEFAULT_TERMS = (today: string): LicenseTerms => ({
  commercialUse: true,
  derivativeReports: 'allowed',
  rawRedistribution: false,
  allowedPurposes: ['internal_research', 'commercial_report'],
  territories: null,
  validFrom: today,
  validUntil: null,
  attributionText: null,
  economics: { kind: 'percent_of_gross', bps: 1000 },
  aiAnswers: { allowed: true, centsPerCitation: 2 },
  payableOn: 'included_in_build',
  currency: 'USD',
});
