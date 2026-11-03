import { XMLParser } from 'fast-xml-parser';
import { LicenseTermsSchema, type LicenseTerms } from '@tracepay/shared';
import type { ExtractionResult, FieldEvidence, TermField } from './extract';

/**
 * RSL — Really Simple Licensing 1.0 (rslstandard.org, RSL-SPEC-1.0, 2025-12-10): the open XML
 * standard publishers use to state how AI may use their content and what it costs.
 *
 * A source whose terms are already published in RSL doesn't need AI to read them: this maps the
 * document onto TracePay's terms exactly, element by element, quoting the element behind each term.
 * As the spec requires (§3.1.1), it reads conservatively: a right is granted only where the document
 * grants it, and anything TracePay can't honour leaves AI use off with a warning. Like any draft, the
 * result is enforced only once the contributor offers it and the licensee accepts.
 */

export const RSL_NAMESPACE = 'https://rslstandard.org/rsl';
export const RSL_VERSION = 'RSL 1.0';

/** An RSL document: an <rsl> root in the RSL namespace. */
export const looksLikeRsl = (text: string) => /<(?:\w+:)?rsl[\s>]/.test(text) && text.includes(RSL_NAMESPACE);

/** Usage values that cover answering questions from the content (§3.4.1.1: ai-input is "input into AI models, including retrieval-augmented generation"). */
const ANSWER_USAGE = ['all', 'ai-all', 'ai-input'];

/** Standard licenses by their canonical URL (§3.8: the URL identifies the license). */
const STANDARDS: Array<[RegExp, string]> = [
  [/creativecommons\.org\/licenses\/by\/4\.0/, 'CC BY 4.0'],
  [/creativecommons\.org\/licenses\/by-sa\/4\.0/, 'CC BY-SA 4.0'],
  [/creativecommons\.org\/licenses\/by-nc\/4\.0/, 'CC BY-NC 4.0'],
  [/creativecommons\.org\/licenses\/by-nc-sa\/4\.0/, 'CC BY-NC-SA 4.0'],
  [/creativecommons\.org\/licenses\/by-nd\/4\.0/, 'CC BY-ND 4.0'],
  [/creativecommons\.org\/licenses\/by-nc-nd\/4\.0/, 'CC BY-NC-ND 4.0'],
];

export class RslError extends Error {}

type Node = Record<string, unknown>;
const list = (v: unknown): Node[] => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((x) => (typeof x === 'object' && x ? (x as Node) : { '#text': String(x) })));
const text = (n: Node | undefined) => (n?.['#text'] === undefined ? '' : String(n['#text']).trim());
/** A permits/prohibits element's values ("ai-input search" or "ai-input, search"). */
const values = (n: Node) => text(n).toLowerCase().split(/[\s,]+/).filter(Boolean);
const tag = (name: string, attrs: Record<string, string>, body: string) =>
  `<${name}${Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join('')}>${body}</${name}>`;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

export function readRsl(xml: string, today: string): ExtractionResult {
  // No document type declarations: entity definitions are the classic way to make an XML parser
  // expand or fetch things it shouldn't, and RSL doesn't use them.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new RslError('This RSL document declares a document type or entities, which RSL doesn’t use. Remove the <!DOCTYPE …> part.');
  let doc: Node;
  try {
    doc = parser.parse(xml, true) as Node;
  } catch (err) {
    throw new RslError(`This isn’t well-formed XML: ${(err as Error).message.split('\n')[0]}`);
  }
  const root = list(doc.rsl)[0];
  if (!root) throw new RslError('No <rsl> element found.');
  const contents = list(root.content);
  if (contents.length === 0) throw new RslError('The RSL document has no <content> element.');

  const evidence: FieldEvidence[] = [];
  const warnings: string[] = [];
  const ev = (field: TermField, quote: string | null, confidence: FieldEvidence['confidence'], note?: string) => evidence.push({ field, quote, confidence, ...(note ? { note } : {}) });

  // The license that grants answering with AI, if any; otherwise the first one.
  const licenses = contents.flatMap((c) => list(c.license).map((l) => ({ content: c, license: l })));
  if (licenses.length === 0) throw new RslError('The <content> element has no <license>.');
  const grants = (l: Node, kind: 'permits' | 'prohibits', type: string) => list(l[kind]).filter((p) => p.type === type);
  const answerable = (l: Node) =>
    grants(l, 'permits', 'usage').some((p) => values(p).some((v) => ANSWER_USAGE.includes(v))) &&
    !grants(l, 'prohibits', 'usage').some((p) => values(p).some((v) => ANSWER_USAGE.includes(v)));
  const chosen = licenses.find((x) => answerable(x.license)) ?? licenses[0]!;
  const { content, license } = chosen;
  if (licenses.length > 1) warnings.push(`The document offers ${licenses.length} licenses; this draft follows the one${answerable(license) ? ' that allows AI answers' : ' listed first'} (for ${String(content.url ?? '/')}).`);

  // Usage: may an AI answer questions from it?
  const usagePermits = grants(license, 'permits', 'usage');
  const usageProhibits = grants(license, 'prohibits', 'usage');
  const aiAllowed = answerable(license);
  const usageQuote = [...usagePermits.map((p) => tag('permits', { type: 'usage' }, text(p))), ...usageProhibits.map((p) => tag('prohibits', { type: 'usage' }, text(p)))].join(' ') || null;
  if (!usageQuote) warnings.push('The license doesn’t say AI may use the content, so AI answers are off (RSL licenses are read conservatively).');
  else if (!aiAllowed) warnings.push('The license doesn’t permit using the content as AI input (ai-input, ai-all or all), so AI answers are off.');
  // Compatible, not a problem: noted on the term, not warned about.
  const noTraining = usageProhibits.some((p) => values(p).includes('ai-train')) ? 'AI training is prohibited, which fits: TracePay never trains models on sources.' : undefined;

  // Users: commercial or not.
  const userPermits = grants(license, 'permits', 'user').flatMap(values);
  const userProhibits = grants(license, 'prohibits', 'user').flatMap(values);
  const commercialUse = userPermits.includes('commercial') && !userProhibits.includes('commercial');
  const userQuote =
    [...grants(license, 'permits', 'user').map((p) => tag('permits', { type: 'user' }, text(p))), ...grants(license, 'prohibits', 'user').map((p) => tag('prohibits', { type: 'user' }, text(p)))].join(' ') || null;
  ev('commercialUse', userQuote, userQuote ? 'high' : 'low', userQuote ? undefined : 'Not stated; read conservatively as not granted.');
  if (!userQuote) warnings.push('The license doesn’t say commercial use is permitted, so the draft allows internal research only. Change this if commercial use is granted.');
  const allowedPurposes: LicenseTerms['allowedPurposes'] = commercialUse ? ['internal_research', 'commercial_report'] : ['internal_research'];
  ev('allowedPurposes', userQuote, userQuote ? 'high' : 'low');

  // Countries.
  const geoPermits = grants(license, 'permits', 'geo').flatMap(values).map((c) => c.toUpperCase());
  const geoProhibits = grants(license, 'prohibits', 'geo').flatMap(values).map((c) => c.toUpperCase());
  const territories = geoPermits.filter((c) => /^[A-Z]{2}$/.test(c) && !geoProhibits.includes(c));
  const geoQuote = [...grants(license, 'permits', 'geo').map((p) => tag('permits', { type: 'geo' }, text(p))), ...grants(license, 'prohibits', 'geo').map((p) => tag('prohibits', { type: 'geo' }, text(p)))].join(' ') || null;
  let geoBlocksAi = false;
  if (geoProhibits.length && territories.length === 0) {
    // TracePay lists the countries a license covers; "everywhere except…" can't be written as such a list.
    geoBlocksAi = true;
    warnings.push(`The license excludes ${geoProhibits.join(', ')}. List the countries it does cover before offering it; until then AI answers are off.`);
  }
  ev('territories', geoQuote, geoQuote ? (geoBlocksAi ? 'low' : 'high') : 'medium', geoQuote ? undefined : 'No country limits: worldwide.');

  // Payment (§3.7; absent means free).
  const payments = list(license.payment);
  const payment = payments[0];
  const payType = String(payment?.type ?? 'free');
  const amountNode = list(payment?.amount)[0];
  const currency = String(amountNode?.currency ?? '').toUpperCase();
  const amount = Number(text(amountNode));
  const standardUrl = text(list(payment?.standard)[0]);
  const customUrl = text(list(payment?.custom)[0]);
  const licenseName = STANDARDS.find(([re]) => re.test(standardUrl))?.[1];
  const payQuote = payment
    ? tag('payment', payment?.type ? { type: payType } : {}, [amountNode ? tag('amount', { currency }, text(amountNode)) : '', standardUrl ? tag('standard', {}, standardUrl) : '', customUrl ? tag('custom', {}, customUrl) : ''].join(''))
    : null;
  if (payments.length > 1) warnings.push(`The license lists ${payments.length} payment options; this draft follows the first (${payType}).`);

  let centsPerCitation = 0;
  let economics: LicenseTerms['economics'] = { kind: 'none' };
  let payBlocksAi = false;
  if (payType === 'use') {
    // "Payment each time the content contributes to an AI-generated output": per cited passage in an
    // answer, and per sale of a report that cites it.
    if (currency !== 'USD' || !Number.isFinite(amount) || amount < 0) {
      payBlocksAi = true;
      warnings.push(`The per-use price is ${text(amountNode) || 'missing'} ${currency || '(no currency)'}; TracePay pays in US dollars. Set the rate in USD before offering it; until then AI answers are off.`);
    } else {
      centsPerCitation = Math.round(amount * 100);
      if (centsPerCitation > 500) {
        payBlocksAi = true;
        warnings.push(`The per-use price (${amount} USD) is above TracePay’s per-citation limit of $5.00; AI answers are off until it’s agreed.`);
        centsPerCitation = 0;
      }
      economics = { kind: 'fixed_per_sale', amountCents: Math.round(amount * 100) };
      if (amount > 0 && Math.round(amount * 100) === 0) warnings.push(`The per-use price (${amount} USD) is below one cent; TracePay rounds it to $0.00.`);
    }
  } else if (['purchase', 'subscription', 'training', 'crawl', 'contribution'].includes(payType)) {
    payBlocksAi = true;
    warnings.push(`The license asks for a ${payType} payment, which TracePay doesn’t collect per answer. Arrange it with the licensee, then set the terms; until then AI answers are off.`);
  } else if ((standardUrl && !licenseName) || customUrl) {
    // Terms referred to, not stated (a collective's license, a publisher's licensing page): "free" by
    // default would be a guess the spec forbids (§3.1.1).
    payBlocksAi = true;
    warnings.push(`The license refers to terms at ${standardUrl || customUrl} that TracePay can’t read. Check them, then set the terms; until then AI answers are off.`);
  }
  // attribution and free: no money owed.

  const attribution = payType === 'attribution';
  const copyright = text(list(content.copyright)[0]);
  const attributionText = attribution ? [copyright || 'Credit the original source', licenseName ?? (standardUrl || null), String(content.url ?? '')].filter(Boolean).join(' · ') : null;
  if (attribution) warnings.push('Every report and answer must credit the source with a link (RSL attribution). Check the credit line.');

  const aiAnswersAllowed = aiAllowed && !payBlocksAi && !geoBlocksAi;
  ev('aiAnswers', [usageQuote, payQuote].filter(Boolean).join(' ') || null, usageQuote ? 'high' : 'low', aiAnswersAllowed ? noTraining : 'Off: see the warnings.');
  ev('economics', payQuote, payment ? 'high' : 'medium', payment ? undefined : 'No <payment>: free under RSL.');
  ev('payableOn', payQuote, 'medium', 'Paid only when a passage is actually cited.');
  ev('derivativeReports', usageQuote, usageQuote ? 'high' : 'low');
  ev('attributionText', attribution ? payQuote : null, attribution ? 'medium' : 'high');
  ev('rawRedistribution', null, 'medium', 'RSL governs automated use; copying the source out is not granted.');
  ev('validFrom', null, 'medium', 'From today.');
  ev('validUntil', null, 'medium', 'No end date in RSL; ends when withdrawn.');

  const terms = LicenseTermsSchema.parse({
    commercialUse,
    // Reports are AI-generated from the source too: the same conditions apply.
    derivativeReports: !aiAnswersAllowed ? 'prohibited' : attribution ? 'allowed_with_attribution' : 'allowed',
    rawRedistribution: false,
    allowedPurposes,
    territories: territories.length ? territories : null,
    validFrom: today,
    validUntil: null,
    attributionText,
    ...(licenseName ? { licenseName } : {}),
    economics,
    aiAnswers: { allowed: aiAnswersAllowed, centsPerCitation },
    payableOn: 'cited_in_output',
    currency: 'USD',
  });
  return { terms, evidence, warnings, source: 'rsl', model: RSL_VERSION };
}
