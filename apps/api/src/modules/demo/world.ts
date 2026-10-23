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
  // Real open-access papers, held for the library under their own public licenses. Their authors
  // haven't joined TracePay, so nothing is owed to them; the credit lines name them.
  { id: 'user_arxiv', email: 'papers@open-access.example', name: 'Open-access papers (via arXiv)', role: 'contributor' },
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
  /** Null: the work carries no license to reuse it, so no grant exists (it is never used). */
  licenseId: string | null;
  terms: LicenseTerms;
  /** Plain-language license text, used later for the AI term-extraction demo. */
  licenseText: string;
}

/** The terms a standard open license gives anyone: free, perpetual, worldwide, with credit. */
function openLicense(licenseName: string, validFrom: string, attributionText: string): LicenseTerms {
  return {
    commercialUse: true,
    derivativeReports: 'allowed_with_attribution',
    rawRedistribution: true,
    allowedPurposes: ['internal_research', 'commercial_report'],
    territories: null,
    validFrom,
    validUntil: null,
    attributionText,
    licenseName,
    currency: 'USD',
    economics: { kind: 'none' },
    aiAnswers: { allowed: true, centsPerCitation: 0 },
    payableOn: 'included_in_build',
  };
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

  // ---- real papers, under their real licenses ------------------------------------------
  {
    id: 'asset_arxiv_ziegler_2022',
    ownerId: 'user_arxiv',
    title: 'Productivity Assessment of Neural Code Completion (Ziegler et al., 2022)',
    kind: 'research_notes',
    description: 'GitHub study of how developers perceive the productivity of an AI code-completion tool. arXiv:2205.06537.',
    file: 'arxiv-ziegler-2022.md',
    licenseId: 'lic_arxiv_ziegler_2022',
    terms: { ...openLicense('CC BY 4.0', '2022-05-13', 'Ziegler et al., “Productivity Assessment of Neural Code Completion”, arXiv:2205.06537 (2022), CC BY 4.0') },
    licenseText: 'Creative Commons Attribution 4.0 International (CC BY 4.0): anyone may share and adapt the work for any purpose, including commercially, provided they give appropriate credit.',
  },
  {
    id: 'asset_arxiv_dohmke_2023',
    ownerId: 'user_arxiv',
    title: 'Sea Change in Software Development (Dohmke, Iansiti & Richards, 2023)',
    kind: 'research_notes',
    description: 'Economic and productivity analysis of AI-powered developer tools. arXiv:2306.15033.',
    file: 'arxiv-dohmke-2023.md',
    licenseId: 'lic_arxiv_dohmke_2023',
    terms: { ...openLicense('CC BY 4.0', '2023-06-26', 'Dohmke, Iansiti & Richards, “Sea Change in Software Development”, arXiv:2306.15033 (2023), CC BY 4.0') },
    licenseText: 'Creative Commons Attribution 4.0 International (CC BY 4.0): anyone may share and adapt the work for any purpose, including commercially, provided they give appropriate credit.',
  },
  {
    id: 'asset_arxiv_nam_2023',
    ownerId: 'user_arxiv',
    title: 'Using an LLM to Help With Code Understanding (Nam et al., 2023)',
    kind: 'research_notes',
    description: 'A user study of an in-IDE LLM assistant for understanding code. arXiv:2307.08177.',
    file: 'arxiv-nam-2023.md',
    licenseId: 'lic_arxiv_nam_2023',
    terms: {
      ...openLicense('CC BY-NC-SA 4.0', '2023-07-17', 'Nam et al., “Using an LLM to Help With Code Understanding”, arXiv:2307.08177 (2023), CC BY-NC-SA 4.0'),
      commercialUse: false,
      allowedPurposes: ['internal_research'],
    },
    licenseText: 'Creative Commons Attribution-NonCommercial-ShareAlike 4.0 (CC BY-NC-SA 4.0): share and adapt for non-commercial purposes only, with credit, under the same license.',
  },
  {
    id: 'asset_arxiv_sarkar_2022',
    ownerId: 'user_arxiv',
    title: 'What is it like to program with artificial intelligence? (Sarkar et al., 2022)',
    kind: 'research_notes',
    description: 'A review of how programming with large language models differs from earlier assistance. arXiv:2208.06213.',
    file: 'arxiv-sarkar-2022.md',
    licenseId: 'lic_arxiv_sarkar_2022',
    terms: {
      ...openLicense('CC BY-NC-ND 4.0', '2022-08-12', 'Sarkar et al., “What is it like to program with artificial intelligence?”, arXiv:2208.06213 (2022), CC BY-NC-ND 4.0'),
      commercialUse: false,
      allowedPurposes: ['internal_research'],
      derivativeReports: 'prohibited',
      // No derivatives: an AI answer built from it is an adaptation.
      aiAnswers: { allowed: false, centsPerCitation: 0 },
    },
    licenseText: 'Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 (CC BY-NC-ND 4.0): share unchanged copies for non-commercial purposes only, with credit; no adaptations.',
  },
  {
    id: 'asset_arxiv_peng_2023',
    ownerId: 'user_arxiv',
    title: 'The Impact of AI on Developer Productivity: Evidence from GitHub Copilot (Peng et al., 2023)',
    kind: 'research_notes',
    description: 'A controlled experiment on developer speed with an AI pair programmer. arXiv:2302.06590.',
    file: 'arxiv-peng-2023.md',
    // arXiv's non-exclusive distribution license lets arXiv distribute the paper; it grants nobody else a license to reuse it.
    licenseId: null,
    terms: { ...openLicense('arXiv non-exclusive distribution license', '2023-02-13', 'Peng et al., arXiv:2302.06590 (2023)') },
    licenseText: 'arXiv.org perpetual, non-exclusive license to distribute: arXiv may distribute the paper; no license to reuse it is granted to anyone else.',
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
