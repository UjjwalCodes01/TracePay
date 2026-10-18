import type { Db } from '../db';
import type { AuthUser } from '../modules/auth/auth.service';
import { HttpError } from './errors';

/**
 * Tenant isolation. Every record that isn't public belongs to one publisher.
 * Lookups for someone else's record answer 404, not 403, so callers can't
 * even learn that it exists.
 */

const notFound = (what: string) => new HttpError(404, `${what} not found.`);
export const isAdmin = (u: AuthUser) => u.role === 'admin';

/** Prisma filter: records owned by this publisher (admins see everything). */
export function publisherScope(u: AuthUser): { publisherId?: string } {
  return isAdmin(u) ? {} : { publisherId: u.id };
}

export async function ownedBuild(db: Db, u: AuthUser, buildId: string) {
  const build = await db.buildJob.findUnique({ where: { id: buildId }, select: { id: true, publisherId: true } });
  if (!build || (!isAdmin(u) && build.publisherId !== u.id)) throw notFound('Build');
  return build;
}

export async function ownedSettlement(db: Db, u: AuthUser, runId: string) {
  const run = await db.settlementRun.findUnique({
    where: { id: runId },
    select: { id: true, sale: { select: { artifact: { select: { buildJob: { select: { publisherId: true } } } } } } },
  });
  if (!run || (!isAdmin(u) && run.sale.artifact.buildJob.publisherId !== u.id)) throw notFound('Settlement');
  return run;
}

export type ArtifactAccess = 'owner' | 'buyer' | 'contributor' | 'public';

/**
 * Who may see what about an artifact:
 *  - owner (its publisher) and admins: everything;
 *  - a buyer with a captured purchase: the full report, provenance and receipt;
 *  - a contributor whose source it uses: provenance and receipt (to verify their royalty);
 *  - anyone else: the storefront preview only.
 */
export async function artifactAccess(db: Db, u: AuthUser | undefined, artifactId: string): Promise<ArtifactAccess> {
  const artifact = await db.artifact.findUnique({
    where: { id: artifactId },
    select: { status: true, buildJob: { select: { publisherId: true, sources: { select: { assetVersion: { select: { asset: { select: { ownerId: true } } } } } } } } },
  });
  if (!artifact) throw notFound('Report');
  if (u && (isAdmin(u) || artifact.buildJob.publisherId === u.id)) return 'owner';
  if (u?.role === 'buyer' && (await db.sale.count({ where: { artifactId, buyerId: u.id, status: 'captured' } })) > 0) return 'buyer';
  if (u?.role === 'contributor' && artifact.buildJob.sources.some((s) => s.assetVersion.asset.ownerId === u.id)) return 'contributor';
  if (artifact.status !== 'listed') throw notFound('Report');
  return 'public';
}

export async function requireArtifactAccess(db: Db, u: AuthUser | undefined, artifactId: string, allowed: ArtifactAccess[]) {
  const level = await artifactAccess(db, u, artifactId);
  if (!allowed.includes(level)) throw notFound('Report');
  return level;
}
