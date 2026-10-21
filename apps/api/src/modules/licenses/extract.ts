import { z } from 'zod';
import { LicenseTermsSchema, type LicenseTerms } from '@tracepay/shared';
import { generateStructured } from '../../integrations/ai/vertex';

/**
 * License-term extraction. Turns a plain-language license into DRAFT
 * normalized terms for a human to review. Nothing extracted here is ever
 * enforced until the contributor confirms it and the licensee accepts it.
 */

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
  | 'validUntil';

export interface FieldEvidence {
  field: TermField;
  /** The sentence the value came from, verbatim from the document; null when defaulted. */
  quote: string | null;
  confidence: 'high' | 'medium' | 'low';
  note?: string;
}

export interface ExtractionResult {
  terms: LicenseTerms;
  evidence: FieldEvidence[];
  warnings: string[];
  source: 'vertex' | 'rules';
  model: string;
}

export const MAX_LICENSE_TEXT = 20_000;

// ---------------------------------------------------------------- shared helpers

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');

function toIsoDate(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/** Finds the first date in a string: "31 Dec 2027", "December 31, 2027" or "2027-12-31". */
export function findDate(s: string): string | null {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s);
  if (iso) return toIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dmy = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/i.exec(s);
  if (dmy) return toIsoDate(Number(dmy[3]), MONTHS.indexOf(dmy[2]!.toLowerCase().slice(0, 3)) + 1, Number(dmy[1]));
  const mdy = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i.exec(s);
  if (mdy) return toIsoDate(Number(mdy[3]), MONTHS.indexOf(mdy[1]!.toLowerCase().slice(0, 3)) + 1, Number(mdy[2]));
  return null;
}

const COUNTRIES: Record<string, string> = {
  'united states': 'US', usa: 'US', 'united kingdom': 'GB', uk: 'GB', canada: 'CA', india: 'IN', germany: 'DE',
  france: 'FR', australia: 'AU', japan: 'JP', singapore: 'SG', ireland: 'IE', netherlands: 'NL', spain: 'ES', italy: 'IT',
};

function sentencesOf(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?;])\s+(?=[A-Z"“(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const clip = (s: string) => (s.length > 280 ? `${s.slice(0, 277)}…` : s);
const normalize = (s: string) => s.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- rule-based extractor

/**
 * Deterministic extractor used when no Gemini model is configured, and as a
 * cross-check. It errs on the side of the most restrictive reading and says
 * so in its warnings whenever it has to assume.
 */
export function extractWithRules(text: string, today: string): ExtractionResult {
  const sentences = sentencesOf(text);
  const find = (re: RegExp) => sentences.find((s) => re.test(s)) ?? null;
  const evidence: FieldEvidence[] = [];
  const warnings: string[] = [];
  const ev = (field: TermField, quote: string | null, confidence: FieldEvidence['confidence'], note?: string) =>
    evidence.push({ field, quote: quote ? clip(quote) : null, confidence, ...(note ? { note } : {}) });

  // Commercial use & purposes
  const internalOnly = find(/internal (?:research|use)[^.]*\bonly\b|\bonly\b[^.]*internal|no commercial use|non-commercial|not (?:be )?used commercially/i);
  const commercial = find(/\bcommercial\b|\bsell\b|\bsale\b|\bresell\b/i);
  let commercialUse: boolean;
  if (internalOnly) {
    commercialUse = false;
    ev('commercialUse', internalOnly, 'high');
  } else if (commercial) {
    commercialUse = true;
    ev('commercialUse', commercial, 'high');
  } else {
    commercialUse = false;
    ev('commercialUse', null, 'low', 'No commercial permission found.');
    warnings.push('No commercial permission was found, so the draft allows internal research only. Change this if commercial use is granted.');
  }
  const allowedPurposes: LicenseTerms['allowedPurposes'] = commercialUse ? ['internal_research', 'commercial_report'] : ['internal_research'];
  ev('allowedPurposes', internalOnly ?? commercial, commercialUse || internalOnly ? 'high' : 'low');

  // Derivative reports & attribution
  const noDerivs = find(/no derivative|derivatives? (?:works? )?(?:are|is) (?:not permitted|prohibited)|may not (?:create|make|produce) derivative|prohibit\w* (?:the )?(?:creation of )?derivative/i);
  const attribution = /(?:credit|attribut\w*)[^"“]{0,80}["“]([^"”]{3,200})["”]/i.exec(text);
  let derivativeReports: LicenseTerms['derivativeReports'];
  let attributionText: string | null = null;
  if (noDerivs) {
    derivativeReports = 'prohibited';
    ev('derivativeReports', noDerivs, 'high');
  } else if (attribution) {
    derivativeReports = 'allowed_with_attribution';
    attributionText = attribution[1]!.trim();
    ev('derivativeReports', find(/credit|attribut/i), 'high');
  } else {
    derivativeReports = commercialUse ? 'allowed' : 'allowed';
    const mention = find(/derivative|derived|reports?/i);
    ev('derivativeReports', mention, mention ? 'medium' : 'low', mention ? undefined : 'Assumed allowed; the document does not mention derivative works.');
    if (!mention) warnings.push('The document does not mention derivative reports. The draft allows them; confirm this is intended.');
  }
  ev('attributionText', attribution ? find(/credit|attribut/i) : null, attribution ? 'high' : 'medium');

  // Raw redistribution
  const rawNo = find(/raw[^.]*(?:may not|must not|cannot|can't|not be|not permitted|prohibited)|(?:may not|must not|cannot)[^.]*(?:redistribut|republish)/i);
  const rawYes = find(/raw[^.]*(?:may|can) be (?:redistribut|republish|shar)/i);
  const rawRedistribution = Boolean(rawYes && !rawNo);
  if (rawNo || rawYes) ev('rawRedistribution', rawNo ?? rawYes, 'high');
  else {
    ev('rawRedistribution', null, 'low', 'Not mentioned; defaulted to not allowed.');
    warnings.push('Raw-data redistribution is not mentioned, so the draft does not allow it.');
  }

  // Economics
  const pctSentence = find(/\d{1,3}(?:\.\d{1,2})?\s?%/);
  const fixedSentence = find(/(?:USD|US\$|\$)\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\s*(?:per|for each|each)\s+(?:report|sale|copy|unit|deliverable|download)/i);
  const pct = pctSentence ? Number(/(\d{1,3}(?:\.\d{1,2})?)\s?%/.exec(pctSentence)![1]) : null;
  let economics: LicenseTerms['economics'];
  if (pct !== null && pct <= 100) {
    economics = { kind: 'percent_of_gross', bps: Math.round(pct * 100) };
    ev('economics', pctSentence, 'high');
    if (fixedSentence) warnings.push('Both a percentage and a fixed fee were found. Only one payment rule per license is supported; the draft uses the percentage.');
  } else if (fixedSentence) {
    const amount = /(?:USD|US\$|\$)\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/.exec(fixedSentence)![1]!.replace(/,/g, '');
    const [whole, frac = ''] = amount.split('.');
    economics = { kind: 'fixed_per_sale', amountCents: Number(whole) * 100 + Number(frac.padEnd(2, '0')) };
    ev('economics', fixedSentence, 'high');
  } else if (pct !== null) {
    economics = { kind: 'none' };
    ev('economics', pctSentence, 'low', 'A share above 100% is not possible.');
    warnings.push(`The document states a ${pct}% share, which is above 100%. Enter the correct payment.`);
  } else {
    economics = { kind: 'none' };
    ev('economics', null, 'low', 'No payment term found.');
    warnings.push('No royalty or fee was found, so the draft pays nothing. Add the agreed payment.');
  }

  // When payment is owed
  const citedOnly = find(/only[^.]*\bcit(?:e|ed|es|ing|ation)|\bcit(?:e|ed|es)\b[^.]*\bonly\b/i);
  const payableOn: LicenseTerms['payableOn'] = citedOnly ? 'cited_in_output' : 'included_in_build';
  ev('payableOn', citedOnly, citedOnly ? 'high' : 'medium', citedOnly ? undefined : 'Payable whenever the source is part of an approved build.');

  // Territory
  const worldwide = find(/worldwide|world-wide|globally|any (?:country|territory)/i);
  let territories: string[] | null = null;
  if (worldwide) ev('territories', worldwide, 'high');
  else {
    const territorySentence = find(/\b(?:only|solely|exclusively)\b[^.]*\b(?:in|within)\b/i);
    const codes = territorySentence
      ? Object.entries(COUNTRIES)
          .filter(([name]) => new RegExp(`\\b${name}\\b`, 'i').test(territorySentence))
          .map(([, code]) => code)
      : [];
    if (codes.length) {
      territories = [...new Set(codes)];
      ev('territories', territorySentence, 'medium');
    } else {
      ev('territories', null, 'low', 'No territory restriction found; assumed worldwide.');
      warnings.push('No territory was stated, so the draft applies worldwide.');
    }
  }

  // Validity
  const untilSentence = find(/\b(?:until|through|expires?|expiring|ends?|valid to|terminat\w*)\b[^.]*\d{4}/i);
  // Read the date that follows the keyword, so "from 1 Jan 2026 until 31 Dec 2027" ends in 2027.
  const untilKeyword = untilSentence ? /\b(?:until|through|expires?(?: on)?|expiring|ends?(?: on)?|valid to|terminat\w*)\b/i.exec(untilSentence) : null;
  const validUntil = untilSentence ? findDate(untilSentence.slice(untilKeyword ? untilKeyword.index : 0)) : null;
  ev('validUntil', validUntil ? untilSentence : null, validUntil ? 'high' : 'medium', validUntil ? undefined : 'No end date found; open-ended.');
  const fromSentence = find(/\b(?:from|starting|effective|commenc\w*|begins?)\b[^.]*\d{4}/i);
  let validFrom = (fromSentence && findDate(fromSentence)) || today;
  ev('validFrom', validFrom !== today ? fromSentence : null, validFrom !== today ? 'high' : 'medium', validFrom !== today ? undefined : 'Starts today.');
  if (validUntil && validUntil < validFrom) {
    // The document's term has already ended: keep a valid draft, and say so loudly.
    validFrom = validUntil;
    warnings.unshift(`This license ended on ${validUntil}. It can't be offered as-is; set a new end date if it has been renewed.`);
  }

  if (/\b(?:EUR|GBP|INR|€|£|₹)/.test(text)) warnings.push('Only USD payment terms are supported; amounts in other currencies were not converted.');

  const terms: LicenseTerms = {
    commercialUse,
    derivativeReports,
    rawRedistribution,
    allowedPurposes,
    territories,
    validFrom,
    validUntil,
    attributionText,
    economics,
    payableOn,
    currency: 'USD',
  };
  return { terms: LicenseTermsSchema.parse(terms), evidence, warnings, source: 'rules', model: 'rules/license-extractor-v1' };
}

// ---------------------------------------------------------------- Gemini extractor

const AiExtraction = z.object({
  commercialUse: z.boolean(),
  allowedPurposes: z.array(z.enum(['internal_research', 'commercial_report'])).min(1),
  derivativeReports: z.enum(['allowed', 'allowed_with_attribution', 'prohibited']),
  attributionText: z.string().nullable(),
  rawRedistribution: z.boolean(),
  paymentKind: z.enum(['percent_of_gross', 'fixed_per_sale', 'none']),
  percentOfGross: z.number().min(0).max(100).nullable(),
  fixedFeeUsd: z.number().min(0).max(100_000).nullable(),
  payableOn: z.enum(['included_in_build', 'cited_in_output']),
  territories: z.array(z.string().length(2)).nullable(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  evidence: z.array(
    z.object({
      field: z.enum(['commercialUse', 'allowedPurposes', 'derivativeReports', 'attributionText', 'rawRedistribution', 'economics', 'payableOn', 'territories', 'validFrom', 'validUntil']),
      quote: z.string().nullable(),
      confidence: z.enum(['high', 'medium', 'low']),
    }),
  ),
  warnings: z.array(z.string()),
});

const SYSTEM = [
  'You convert a plain-language content license into structured terms for review by a human. You are drafting, not deciding.',
  'Rules:',
  '- Use only what the document says. If something is not stated, choose the MOST RESTRICTIVE reasonable value and add a warning saying you assumed it.',
  '- For every field, give the exact sentence from the document that supports it as "quote" (copied verbatim), or null if you assumed it.',
  '- Dates must be YYYY-MM-DD. Territories are ISO-3166 alpha-2 codes, or null for worldwide.',
  '- percentOfGross is a percentage (25 means 25%). fixedFeeUsd is dollars per sale.',
  '- "cited_in_output" only when payment explicitly depends on the source being cited or used in the final output.',
  '- Never invent attribution text; copy it exactly if the document specifies it.',
].join('\n');

export async function extractWithVertex(text: string, today: string): Promise<ExtractionResult> {
  const { data, model } = await generateStructured({
    system: SYSTEM,
    prompt: `Today is ${today}. License document:\n"""\n${text}\n"""`,
    schema: AiExtraction,
    temperature: 0,
  });

  const economics: LicenseTerms['economics'] =
    data.paymentKind === 'percent_of_gross' && data.percentOfGross !== null
      ? { kind: 'percent_of_gross', bps: Math.round(data.percentOfGross * 100) }
      : data.paymentKind === 'fixed_per_sale' && data.fixedFeeUsd !== null
        ? { kind: 'fixed_per_sale', amountCents: Math.round(data.fixedFeeUsd * 100) }
        : { kind: 'none' };

  const draft = {
    commercialUse: data.commercialUse,
    derivativeReports: data.derivativeReports,
    rawRedistribution: data.rawRedistribution,
    allowedPurposes: data.commercialUse ? data.allowedPurposes : (['internal_research'] as const),
    territories: data.territories?.map((t) => t.toUpperCase()) ?? null,
    validFrom: (data.validFrom && findDate(data.validFrom)) || today,
    validUntil: data.validUntil ? findDate(data.validUntil) : null,
    attributionText: data.derivativeReports === 'allowed_with_attribution' ? data.attributionText : null,
    economics,
    payableOn: data.payableOn,
    currency: 'USD' as const,
  };
  if (draft.validUntil && draft.validUntil < draft.validFrom) {
    draft.validFrom = draft.validUntil;
    data.warnings.unshift(`This license ended on ${draft.validUntil}. Set a new end date if it has been renewed.`);
  }
  const parsed = LicenseTermsSchema.safeParse(draft);
  if (!parsed.success) {
    const fallback = extractWithRules(text, today);
    fallback.warnings.unshift(`The AI draft did not pass validation (${parsed.error.issues[0]?.message}); showing the rule-based draft instead.`);
    return fallback;
  }

  // Anti-hallucination: a quote must actually appear in the document.
  const doc = normalize(text);
  const evidence: FieldEvidence[] = data.evidence.map((e) => {
    if (e.quote && !doc.includes(normalize(e.quote).replace(/…$/, ''))) {
      return { field: e.field, quote: clip(e.quote), confidence: 'low', note: 'This quote was not found in the document. Check this field carefully.' };
    }
    return { field: e.field, quote: e.quote ? clip(e.quote) : null, confidence: e.confidence };
  });
  const unverified = evidence.filter((e) => e.note?.startsWith('This quote was not found')).length;
  const warnings = [...data.warnings];
  if (unverified) warnings.unshift(`${unverified} quoted source sentence(s) could not be found in the document.`);

  return { terms: parsed.data, evidence, warnings, source: 'vertex', model };
}

export async function extractTerms(text: string, opts: { useModel: boolean; today: string }): Promise<ExtractionResult> {
  const doc = text.slice(0, MAX_LICENSE_TEXT);
  if (!opts.useModel) return extractWithRules(doc, opts.today);
  try {
    return await extractWithVertex(doc, opts.today);
  } catch (err) {
    const fallback = extractWithRules(doc, opts.today);
    fallback.warnings.unshift(`AI extraction was unavailable (${(err as Error).message.slice(0, 120)}); showing the rule-based draft.`);
    return fallback;
  }
}
