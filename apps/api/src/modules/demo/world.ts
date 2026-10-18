import type { LicenseTerms } from '@tracepay/shared';

/**
 * The demo world: one research studio (publisher), five fictional
 * contributors, five licensed assets with deliberately different terms.
 *
 *   A Northwind   dataset         commercial, 25% of gross, no raw redistribution
 *   B Okafor      analyst notes   commercial w/ attribution, 15%, paid only if cited
 *   C Kestrel     panel survey    INTERNAL RESEARCH ONLY  → blocks a commercial build
 *   D Lumen       survey digest   commercial, fixed $2.00 per sale → replacement for C
 *   E Pricing     tracker         EXPIRED on 2026-09-30   → never eligible
 */

export const DEMO_IDS = {
  publisher: 'user_atlas',
  buyer: 'user_buyer',
  admin: 'user_admin',
} as const;

export interface DemoUser {
  id: string;
  email: string;
  name: string;
  role: 'publisher' | 'contributor' | 'buyer' | 'admin';
  /** Index into DEMO_PAYEE_EMAILS for contributors who can actually be paid. */
  payeeSlot?: number;
}

export const DEMO_USERS: DemoUser[] = [
  { id: DEMO_IDS.publisher, email: 'studio@atlas-research.example', name: 'Atlas Research Studio', role: 'publisher' },
  { id: DEMO_IDS.buyer, email: 'buyer@tracepay-demo.example', name: 'Demo Buyer', role: 'buyer' },
  { id: DEMO_IDS.admin, email: 'admin@tracepay-demo.example', name: 'TracePay Admin', role: 'admin' },
  { id: 'user_northwind', email: 'licensing@northwind-data.example', name: 'Northwind Data Co.', role: 'contributor', payeeSlot: 0 },
  { id: 'user_okafor', email: 'mara@okafor-analysis.example', name: 'Mara Okafor (independent analyst)', role: 'contributor', payeeSlot: 1 },
  { id: 'user_kestrel', email: 'rights@kestrel-panel.example', name: 'Kestrel Research Panel', role: 'contributor' },
  { id: 'user_lumen', email: 'hello@lumen-collective.example', name: 'Lumen Collective', role: 'contributor', payeeSlot: 2 },
  { id: 'user_pricing', email: 'data@ide-pricing.example', name: 'IDE Pricing Tracker', role: 'contributor' },
];

const base: Omit<LicenseTerms, 'economics' | 'payableOn'> = {
  commercialUse: true,
  derivativeReports: 'allowed',
  rawRedistribution: false,
  allowedPurposes: ['internal_research', 'commercial_report'],
  territories: null,
  validFrom: '2026-01-01',
  validUntil: '2027-12-31',
  attributionText: null,
  currency: 'USD',
};

export interface DemoAsset {
  id: string;
  ownerId: string;
  title: string;
  kind: 'dataset' | 'research_notes' | 'expert_brief' | 'api_feed';
  description: string;
  file: string;
  licenseId: string;
  terms: LicenseTerms;
  /** Plain-language license text, used later for the AI term-extraction demo. */
  licenseText: string;
}

export const DEMO_ASSETS: DemoAsset[] = [
  {
    id: 'asset_northwind_index',
    ownerId: 'user_northwind',
    title: 'Northwind DevTools Spend Index 2026',
    kind: 'dataset',
    description: 'Quarterly developer-tooling spend across 1,200 engineering organisations.',
    file: 'devtools-spend-index.md',
    licenseId: 'lic_northwind_v1',
    terms: { ...base, economics: { kind: 'percent_of_gross', bps: 2500 }, payableOn: 'included_in_build' },
    licenseText:
      'Licensee may use the Index to create and sell derivative research reports worldwide until 31 Dec 2027. ' +
      'Raw index data may not be redistributed. Licensor receives 25% of the gross sale price of each report that uses the Index.',
  },
  {
    id: 'asset_okafor_notes',
    ownerId: 'user_okafor',
    title: 'AI Coding Assistant Field Notes (Q3 2026)',
    kind: 'research_notes',
    description: 'Interview-based analyst notes on how engineering leaders buy and roll out AI assistants.',
    file: 'ai-assistant-field-notes.md',
    licenseId: 'lic_okafor_v1',
    terms: {
      ...base,
      derivativeReports: 'allowed_with_attribution',
      attributionText: 'Field research by Mara Okafor, independent analyst',
      economics: { kind: 'percent_of_gross', bps: 1500 },
      payableOn: 'cited_in_output',
    },
    licenseText:
      'Commercial derivative reports are permitted provided they credit "Field research by Mara Okafor, independent analyst". ' +
      'Royalty: 15% of gross sale price, payable only for reports that actually cite these notes.',
  },
  {
    id: 'asset_kestrel_panel',
    ownerId: 'user_kestrel',
    title: 'Kestrel Enterprise Engineering Panel 2026',
    kind: 'dataset',
    description: 'Survey of 640 engineering directors at large enterprises.',
    file: 'enterprise-panel-survey.md',
    licenseId: 'lic_kestrel_v1',
    terms: {
      ...base,
      commercialUse: false,
      allowedPurposes: ['internal_research'],
      economics: { kind: 'percent_of_gross', bps: 1000 },
      payableOn: 'included_in_build',
    },
    licenseText:
      'Panel results are licensed for the licensee\'s internal research only. No commercial use, sale or publication of ' +
      'derived works is permitted. Fee: 10% of any revenue attributable to the data.',
  },
  {
    id: 'asset_lumen_digest',
    ownerId: 'user_lumen',
    title: 'Open Developer Survey Digest 2026',
    kind: 'expert_brief',
    description: 'Digest of a 9,400-respondent developer survey on AI assistant usage and trust.',
    file: 'open-developer-survey-digest.md',
    licenseId: 'lic_lumen_v1',
    terms: { ...base, economics: { kind: 'fixed_per_sale', amountCents: 200 }, payableOn: 'included_in_build' },
    licenseText:
      'The Digest may be used in commercial derivative reports worldwide. Fee: USD 2.00 per report sold. Raw survey tables may not be republished.',
  },
  {
    id: 'asset_ide_pricing',
    ownerId: 'user_pricing',
    title: 'Cloud IDE Pricing Tracker Q2 2026',
    kind: 'api_feed',
    description: 'Seat and usage pricing across seven fictional cloud IDE vendors.',
    file: 'cloud-ide-pricing-tracker.md',
    licenseId: 'lic_pricing_v1',
    terms: {
      ...base,
      validUntil: '2026-09-30',
      economics: { kind: 'percent_of_gross', bps: 500 },
      payableOn: 'included_in_build',
    },
    licenseText: 'Commercial use permitted until 30 September 2026. Fee: 5% of gross sale price.',
  },
];

/** Split asset content into retrievable chunks (one per paragraph). */
export function chunkContent(content: string): string[] {
  return content
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);
}
