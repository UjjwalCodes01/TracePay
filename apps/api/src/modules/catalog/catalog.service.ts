import { GOVERNING_STATUSES, LicenseTermsSchema, PENDING_STATUSES, type LicenseStatus, type LicenseTerms } from '@tracepay/shared';
import type { Tx } from '../../db';
import type { CompilerSource } from '../license-compiler/compiler';

export interface CatalogEntry {
  assetId: string;
  assetTitle: string;
  kind: string;
  description: string;
  owner: { id: string; name: string };
  assetVersionId: string;
  version: number;
  sha256: string;
  chunkCount: number;
  /** The license in force for this publisher (approved), or the revoked one that blocks it. */
  license: {
    id: string;
    version: number;
    status: LicenseStatus;
    terms: LicenseTerms;
    termsHash: string;
    sourceText: string | null;
  } | null;
  /** A request or offer still awaiting a decision, if any. */
  pending: { id: string; version: number; status: LicenseStatus; terms: LicenseTerms | null } | null;
}

/** A compiler source plus the facts needed to freeze it into a build. */
export interface ResolvedSource extends CompilerSource {
  contributorId: string;
  termsHash: string | null;
}

type GrantRow = { id: string; assetId: string; version: number; status: string; terms: unknown; termsHash: string | null; sourceText: string | null };

/**
 * The license governing (asset, licensee) is the highest-version grant that is
 * approved or revoked. Offers and requests never govern: a renegotiation only
 * takes effect once the licensee accepts it, and a revoked grant is returned
 * as-is so the compiler blocks on it rather than falling back to an older one.
 */
async function grantsFor(tx: Tx, licenseeId: string, assetIds: string[]) {
  const grants = (await tx.licenseGrant.findMany({
    where: { licenseeId, assetId: { in: assetIds }, status: { in: [...GOVERNING_STATUSES, ...PENDING_STATUSES] } },
    orderBy: { version: 'desc' },
    select: { id: true, assetId: true, version: true, status: true, terms: true, termsHash: true, sourceText: true },
  })) as GrantRow[];
  const governing = new Map<string, GrantRow>();
  const pending = new Map<string, GrantRow>();
  for (const g of grants) {
    const target = (GOVERNING_STATUSES as readonly string[]).includes(g.status) ? governing : pending;
    if (!target.has(g.assetId)) target.set(g.assetId, g);
  }
  return { governing, pending };
}

/** Lenient read of stored terms: a grant written under older rules must not crash the catalog. */
export const parseTerms = (t: unknown) => {
  if (!t) return null;
  const r = LicenseTermsSchema.safeParse(t);
  return r.success ? r.data : null;
};

const assetInclude = {
  owner: { select: { id: true, name: true } },
  versions: { orderBy: { version: 'desc' as const }, take: 1, include: { _count: { select: { chunks: true } } } },
};

/** Sources a publisher can see: everything it holds (or held) a license for, plus every live public listing. */
const visibleTo = (publisherId: string) => ({ OR: [{ licenses: { some: { licenseeId: publisherId } } }, { archivedAt: null }] });

async function toEntries(
  tx: Tx,
  publisherId: string,
  assets: Array<{ id: string; title: string; kind: string; description: string; owner: { id: string; name: string }; versions: Array<{ id: string; version: number; sha256: string; _count: { chunks: number } }> }>,
): Promise<CatalogEntry[]> {
  const { governing, pending } = await grantsFor(tx, publisherId, assets.map((a) => a.id));
  return assets.flatMap((a) => {
    const v = a.versions[0];
    if (!v) return [];
    const g = governing.get(a.id);
    const p = pending.get(a.id);
    return [
      {
        assetId: a.id,
        assetTitle: a.title,
        kind: a.kind,
        description: a.description,
        owner: a.owner,
        assetVersionId: v.id,
        version: v.version,
        sha256: v.sha256,
        chunkCount: v._count.chunks,
        license:
          g && g.termsHash && parseTerms(g.terms)
            ? { id: g.id, version: g.version, status: g.status as LicenseStatus, terms: parseTerms(g.terms)!, termsHash: g.termsHash, sourceText: g.sourceText }
            : null,
        pending: p ? { id: p.id, version: p.version, status: p.status as LicenseStatus, terms: parseTerms(p.terms) } : null,
      },
    ];
  });
}

/**
 * The working catalog (dashboard, Publisher Agent): EVERY source this publisher
 * holds or held a license for — never cut off — plus the newest public listings.
 */
export async function listCatalog(tx: Tx, publisherId: string): Promise<CatalogEntry[]> {
  const [licensed, newest] = await Promise.all([
    tx.asset.findMany({ where: { licenses: { some: { licenseeId: publisherId } } }, orderBy: { createdAt: 'asc' }, take: 2_000, include: assetInclude }),
    tx.asset.findMany({ where: { archivedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 500, include: assetInclude }),
  ]);
  const byId = new Map([...licensed, ...newest].map((a) => [a.id, a]));
  const assets = [...byId.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  return toEntries(tx, publisherId, assets);
}

/** One page of the catalog, newest first, for the platform API. */
export async function pageCatalog(
  tx: Tx,
  publisherId: string,
  page: { limit: number; where?: object },
): Promise<{ entries: CatalogEntry[]; rows: Array<{ id: string; createdAt: Date }>; hasMore: boolean }> {
  const rows = await tx.asset.findMany({
    where: { AND: [visibleTo(publisherId), page.where ?? {}] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: page.limit + 1,
    include: assetInclude,
  });
  const hasMore = rows.length > page.limit;
  const pageRows = rows.slice(0, page.limit);
  return { entries: await toEntries(tx, publisherId, pageRows), rows: pageRows, hasMore };
}

/** One source, if this publisher may see it. */
export async function catalogEntry(tx: Tx, publisherId: string, assetId: string): Promise<CatalogEntry | null> {
  const asset = await tx.asset.findFirst({ where: { AND: [{ id: assetId }, visibleTo(publisherId)] }, include: assetInclude });
  return asset ? ((await toEntries(tx, publisherId, [asset]))[0] ?? null) : null;
}

export class UnknownAssetVersionError extends Error {
  constructor(readonly ids: string[]) {
    super(`Unknown asset version(s): ${ids.join(', ')}`);
  }
}

/** Resolves pinned asset versions to compiler inputs, in the order requested. */
export async function resolveSources(tx: Tx, publisherId: string, assetVersionIds: string[]): Promise<ResolvedSource[]> {
  const versions = await tx.assetVersion.findMany({
    where: { id: { in: assetVersionIds } },
    include: { asset: { include: { owner: true } } },
  });
  const byId = new Map(versions.map((v) => [v.id, v]));
  const missing = assetVersionIds.filter((id) => !byId.has(id));
  if (missing.length) throw new UnknownAssetVersionError(missing);

  const { governing } = await grantsFor(tx, publisherId, versions.map((v) => v.assetId));

  return assetVersionIds.map((id) => {
    const v = byId.get(id)!;
    const g = governing.get(v.assetId);
    const terms = g ? parseTerms(g.terms) : null;
    return {
      assetId: v.assetId,
      assetTitle: v.asset.title,
      assetVersionId: v.id,
      contributorId: v.asset.ownerId,
      contributorName: v.asset.owner.name,
      payeeEmail: v.asset.owner.paypalEmail,
      termsHash: g?.termsHash ?? null,
      license: g && terms ? { id: g.id, status: g.status as LicenseStatus, terms } : null,
      ...(g && !terms ? { licenseProblem: 'has license terms that can no longer be read. Ask the contributor to send them again.' } : {}),
    };
  });
}
