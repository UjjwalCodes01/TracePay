import { LicenseTermsSchema, type LicenseStatus, type LicenseTerms } from '@tracepay/shared';
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
  license: {
    id: string;
    version: number;
    status: LicenseStatus;
    terms: LicenseTerms;
    termsHash: string;
    sourceText: string | null;
  } | null;
}

/** A compiler source plus the facts needed to freeze it into a build. */
export interface ResolvedSource extends CompilerSource {
  contributorId: string;
  termsHash: string | null;
}

/**
 * The license currently governing (asset, licensee): the highest version that
 * hasn't been superseded. A revoked grant is returned as-is so the compiler
 * reports it, rather than silently falling back to an older version.
 */
async function currentGrants(tx: Tx, licenseeId: string, assetIds: string[]) {
  const grants = await tx.licenseGrant.findMany({
    where: { licenseeId, assetId: { in: assetIds }, status: { not: 'superseded' } },
    orderBy: { version: 'desc' },
  });
  const byAsset = new Map<string, (typeof grants)[number]>();
  for (const g of grants) if (!byAsset.has(g.assetId)) byAsset.set(g.assetId, g);
  return byAsset;
}

export async function listCatalog(tx: Tx, publisherId: string): Promise<CatalogEntry[]> {
  const assets = await tx.asset.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      owner: { select: { id: true, name: true } },
      versions: { orderBy: { version: 'desc' }, take: 1, include: { _count: { select: { chunks: true } } } },
    },
  });
  const grants = await currentGrants(tx, publisherId, assets.map((a) => a.id));

  return assets.flatMap((a) => {
    const v = a.versions[0];
    if (!v) return [];
    const g = grants.get(a.id);
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
        license: g
          ? {
              id: g.id,
              version: g.version,
              status: g.status as LicenseStatus,
              terms: LicenseTermsSchema.parse(g.terms),
              termsHash: g.termsHash,
              sourceText: g.sourceText,
            }
          : null,
      },
    ];
  });
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

  const grants = await currentGrants(tx, publisherId, versions.map((v) => v.assetId));

  return assetVersionIds.map((id) => {
    const v = byId.get(id)!;
    const g = grants.get(v.assetId);
    return {
      assetId: v.assetId,
      assetTitle: v.asset.title,
      assetVersionId: v.id,
      contributorId: v.asset.ownerId,
      contributorName: v.asset.owner.name,
      payeeEmail: v.asset.owner.paypalEmail,
      termsHash: g?.termsHash ?? null,
      license: g
        ? { id: g.id, status: g.status === 'superseded' ? 'revoked' : (g.status as LicenseStatus), terms: LicenseTermsSchema.parse(g.terms) }
        : null,
    };
  });
}
