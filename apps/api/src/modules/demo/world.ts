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

// ---- private demo worlds ------------------------------------------------------------
//
// Each visitor of a hosted demo gets a private copy of this world: its own publisher, buyer and
// contributors, with the same sources and licenses. Every id in it is the base id with a prefix
// ("dw_<world>_user_atlas"), so whose data is whose is readable from the id alone. The base ids
// (no prefix) are the shared demo world that tests and scripted examples use.

export const WORLD_PREFIX = 'dw_';
const WORLD_ID = /^dw_([a-z0-9]{12})_(.+)$/;

/** A new world id: 12 random lowercase letters and digits. */
export function newWorldId(random: (n: number) => Buffer): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return [...random(12)].map((b) => alphabet[b % alphabet.length]).join('');
}

/** A base demo id as it exists in `world` (unchanged for the shared world, `null`). */
export const inWorld = (world: string | null, baseId: string) => (world ? `${WORLD_PREFIX}${world}_${baseId}` : baseId);

/** The world an id belongs to, or null for the shared demo world and real accounts. */
export const worldOf = (id: string): string | null => WORLD_ID.exec(id)?.[1] ?? null;

/** The id without its world prefix. */
export const baseIdOf = (id: string): string => WORLD_ID.exec(id)?.[2] ?? id;

/** A world's version of a demo email (emails are unique): "studio+<world>@atlas-research.example". */
export const worldEmail = (world: string | null, email: string) => (world ? email.replace('@', `+${world}@`) : email);

/**
 * Ids (of users, sources…) that belong to the same world as `viewerId`, as a Prisma string filter:
 * a world sees only itself; everyone else (real accounts, the shared demo) never sees any world.
 */
export function sameWorld(viewerId: string | null | undefined): { startsWith: string } | { not: { startsWith: string } } {
  const world = viewerId ? worldOf(viewerId) : null;
  return world ? { startsWith: `${WORLD_PREFIX}${world}_` } : { not: { startsWith: WORLD_PREFIX } };
}

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
    terms: { ...base, economics: { kind: 'percent_of_gross', bps: 2500 }, aiAnswers: { allowed: true, centsPerCitation: 3 }, payableOn: 'included_in_build' },
    licenseText:
      'Licensee may use the Index to create and sell derivative research reports worldwide until 31 Dec 2027. ' +
      'Raw index data may not be redistributed. Licensor receives 25% of the gross sale price of each report that uses the Index. ' +
      'AI answer services may cite the Index at USD 0.03 per cited passage.',
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
      aiAnswers: { allowed: true, centsPerCitation: 2 },
      payableOn: 'cited_in_output',
    },
    licenseText:
      'Commercial derivative reports are permitted provided they credit "Field research by Mara Okafor, independent analyst". ' +
      'Royalty: 15% of gross sale price, payable only for reports that actually cite these notes. This license runs until 31 Dec 2027. ' +
      'AI assistants may use these notes in answers at USD 0.02 per cited passage.',
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
      aiAnswers: { allowed: false, centsPerCitation: 0 },
      payableOn: 'included_in_build',
    },
    licenseText:
      'Panel results are licensed for the licensee\'s internal research only. No commercial use, sale or publication of ' +
      'derived works is permitted. Fee: 10% of any revenue attributable to the data. The license is valid until 31 Dec 2027. ' +
      'AI assistants may not use the panel to answer questions.',
  },
  {
    id: 'asset_lumen_digest',
    ownerId: 'user_lumen',
    title: 'Open Developer Survey Digest 2026',
    kind: 'expert_brief',
    description: 'Digest of a 9,400-respondent developer survey on AI assistant usage and trust.',
    file: 'open-developer-survey-digest.md',
    licenseId: 'lic_lumen_v1',
    terms: { ...base, economics: { kind: 'fixed_per_sale', amountCents: 200 }, aiAnswers: { allowed: true, centsPerCitation: 1 }, payableOn: 'included_in_build' },
    licenseText:
      'The Digest may be used in commercial derivative reports worldwide until 31 Dec 2027. Fee: USD 2.00 per report sold. Raw survey tables may not be republished. ' +
      'AI answer services may cite the Digest at USD 0.01 per cited passage.',
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
      aiAnswers: { allowed: true, centsPerCitation: 2 },
      payableOn: 'included_in_build',
    },
    licenseText: 'Commercial use permitted until 30 September 2026. Fee: 5% of gross sale price. AI answer services may cite the tracker at USD 0.02 per cited passage.',
  },
];

export { chunkContent } from '../assets/chunk';

const DEMO_BASE_IDS = new Set(DEMO_USERS.map((u) => u.id));
const ROLE_OF = new Map(DEMO_USERS.map((u) => [u.id, u.role]));

/** A demo persona of any world (or the shared one) with the given role; never an admin unless asked. */
export function demoRoleOf(id: string): DemoUser['role'] | null {
  const base = baseIdOf(id);
  return DEMO_BASE_IDS.has(base) ? (ROLE_OF.get(base) ?? null) : null;
}
export const isDemoPersona = (id: string) => demoRoleOf(id) !== null;
