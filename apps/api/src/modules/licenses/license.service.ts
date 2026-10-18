import { LicenseTermsSchema, type LicenseTerms } from '@tracepay/shared';
import type { Prisma } from '../../generated/prisma/client';
import type { Db, Tx } from '../../db';
import { appendAudit } from '../audit/audit-log';
import { canonicalJson, sha256Hex } from '../audit/hash-chain';
import { todayUtc } from '../builds/preflight.service';
import { withdrawReportsUsingAsset } from '../sales/rights.service';

/**
 * The two-party license lifecycle. A grant only becomes enforceable when the
 * licensor (contributor) has offered exact terms AND the licensee (publisher)
 * has accepted those same terms. Every transition is audited.
 */

export class LicenseError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'forbidden' | 'state' | 'invalid') {
    super(message);
    this.name = 'LicenseError';
  }
}

const json = (v: unknown) => v as Prisma.InputJsonValue;
const termsHash = (t: LicenseTerms) => sha256Hex(canonicalJson(t));

async function nextVersion(tx: Tx, assetId: string, licenseeId: string): Promise<number> {
  const last = await tx.licenseGrant.findFirst({ where: { assetId, licenseeId }, orderBy: { version: 'desc' }, select: { version: true } });
  return (last?.version ?? 0) + 1;
}

/** Serialises lifecycle changes for one (asset, licensee) pair. */
async function lockPair(tx: Tx, assetId: string, licenseeId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${assetId}:${licenseeId}`}))`;
}

async function audit(tx: Tx, grantId: string, eventType: string, payload: Record<string, unknown>) {
  await appendAudit(tx, { entityType: 'license', entityId: grantId, eventType, payload });
}

// ---------------------------------------------------------------- publisher side

export async function requestLicense(db: Db, input: { assetId: string; publisherId: string; message?: string | null }) {
  return db.$transaction(async (tx) => {
    const asset = await tx.asset.findUnique({ where: { id: input.assetId }, select: { id: true, ownerId: true } });
    if (!asset) throw new LicenseError('Source not found.', 'not_found');
    if (asset.ownerId === input.publisherId) throw new LicenseError('You own this source.', 'invalid');
    await lockPair(tx, asset.id, input.publisherId);

    const open = await tx.licenseGrant.findFirst({ where: { assetId: asset.id, licenseeId: input.publisherId, status: { in: ['requested', 'offered'] } } });
    if (open) throw new LicenseError(open.status === 'offered' ? 'An offer is already waiting for your decision.' : 'You already requested this license.', 'state');

    const grant = await tx.licenseGrant.create({
      data: {
        assetId: asset.id,
        licenseeId: input.publisherId,
        version: await nextVersion(tx, asset.id, input.publisherId),
        status: 'requested',
        requestMessage: input.message?.trim().slice(0, 1000) || null,
      },
    });
    await audit(tx, grant.id, 'license.requested', { assetId: asset.id, version: grant.version });
    return grant;
  });
}

export async function acceptOffer(db: Db, input: { grantId: string; publisherId: string; termsHash: string }) {
  return db.$transaction(async (tx) => {
    const grant = await tx.licenseGrant.findUnique({ where: { id: input.grantId } });
    if (!grant || grant.licenseeId !== input.publisherId) throw new LicenseError('Offer not found.', 'not_found');
    await lockPair(tx, grant.assetId, grant.licenseeId);
    const fresh = await tx.licenseGrant.findUniqueOrThrow({ where: { id: grant.id } });
    if (fresh.status !== 'offered') throw new LicenseError(`This offer is ${fresh.status}.`, 'state');
    // The publisher accepts the exact terms they reviewed — not whatever is stored now.
    if (fresh.termsHash !== input.termsHash) throw new LicenseError('These terms changed since you opened them. Review them again.', 'state');
    const offered = LicenseTermsSchema.safeParse(fresh.terms);
    if (!offered.success) throw new LicenseError('This offer has unreadable terms. Ask the contributor to send it again.', 'state');
    if (offered.data.validUntil && offered.data.validUntil < todayUtc()) throw new LicenseError('This offer has already expired. Ask the contributor for new dates.', 'state');

    const previous = await tx.licenseGrant.findMany({ where: { assetId: grant.assetId, licenseeId: grant.licenseeId, status: 'approved' }, select: { id: true } });
    await tx.licenseGrant.updateMany({ where: { id: { in: previous.map((p) => p.id) } }, data: { status: 'superseded' } });
    const accepted = await tx.licenseGrant.update({
      where: { id: grant.id },
      data: { status: 'approved', approvedAt: new Date(), approvedById: input.publisherId },
    });
    await audit(tx, grant.id, 'license.accepted', { termsHash: fresh.termsHash, version: fresh.version, superseded: previous.map((p) => p.id) });
    return accepted;
  });
}

export async function declineOffer(db: Db, input: { grantId: string; publisherId: string; reason?: string | null }) {
  return close(db, input.grantId, { actorId: input.publisherId, side: 'licensee', from: 'offered', to: 'declined', reason: input.reason, event: 'license.declined' });
}

// ---------------------------------------------------------------- contributor side

export interface OfferInput {
  assetId: string;
  contributorId: string;
  licenseeId: string;
  terms: LicenseTerms;
  origin: 'manual' | 'ai_draft' | 'rules_draft';
  sourceText?: string | null;
  extraction?: unknown;
}

/**
 * The contributor confirms exact terms for one publisher. Fulfils that
 * publisher's open request if there is one; replaces (withdraws) any earlier
 * offer still pending. An already-active license stays in force until the
 * publisher accepts this one.
 */
export async function offerLicense(db: Db, input: OfferInput) {
  const terms = LicenseTermsSchema.parse(input.terms);
  if (terms.validUntil && terms.validUntil < todayUtc()) throw new LicenseError('These terms have already expired. Choose a later end date.', 'invalid');
  return db.$transaction(async (tx) => {
    const asset = await tx.asset.findUnique({ where: { id: input.assetId }, select: { id: true, ownerId: true } });
    if (!asset || asset.ownerId !== input.contributorId) throw new LicenseError('Source not found.', 'not_found');
    const licensee = await tx.user.findUnique({ where: { id: input.licenseeId }, select: { id: true, role: true } });
    if (!licensee || licensee.role !== 'publisher') throw new LicenseError('Licenses can only be offered to a publisher account.', 'invalid');
    if (licensee.id === input.contributorId) throw new LicenseError('You cannot license a source to yourself.', 'invalid');
    await lockPair(tx, asset.id, licensee.id);

    const hash = termsHash(terms);
    const data = {
      status: 'offered' as const,
      terms: json(terms),
      termsHash: hash,
      origin: input.origin,
      sourceText: input.sourceText?.slice(0, 20_000) ?? null,
      aiExtraction: input.extraction === undefined ? undefined : json(input.extraction),
      offeredAt: new Date(),
    };

    const open = await tx.licenseGrant.findFirst({ where: { assetId: asset.id, licenseeId: licensee.id, status: { in: ['requested', 'offered'] } } });
    let grant;
    if (open?.status === 'requested') {
      grant = await tx.licenseGrant.update({ where: { id: open.id }, data });
    } else {
      if (open?.status === 'offered') {
        await tx.licenseGrant.update({ where: { id: open.id }, data: { status: 'withdrawn', closedAt: new Date(), closedById: input.contributorId, closedReason: 'Replaced by a newer offer.' } });
        await audit(tx, open.id, 'license.withdrawn', { reason: 'replaced' });
      }
      grant = await tx.licenseGrant.create({
        data: { ...data, assetId: asset.id, licenseeId: licensee.id, version: await nextVersion(tx, asset.id, licensee.id) },
      });
    }
    await audit(tx, grant.id, 'license.offered', { termsHash: hash, version: grant.version, origin: input.origin, fulfilsRequest: open?.status === 'requested' });
    return grant;
  });
}

export async function withdrawOffer(db: Db, input: { grantId: string; contributorId: string; reason?: string | null }) {
  return close(db, input.grantId, { actorId: input.contributorId, side: 'licensor', from: 'offered', to: 'withdrawn', reason: input.reason, event: 'license.withdrawn' });
}

export async function declineRequest(db: Db, input: { grantId: string; contributorId: string; reason?: string | null }) {
  return close(db, input.grantId, { actorId: input.contributorId, side: 'licensor', from: 'requested', to: 'declined', reason: input.reason, event: 'license.request_declined' });
}

/**
 * Revocation stops FUTURE builds from using the source. Sales of reports
 * already built keep settling under their frozen terms, as agreed at the time.
 */
export async function revokeLicense(db: Db, input: { grantId: string; contributorId: string; reason?: string | null }) {
  return close(db, input.grantId, {
    actorId: input.contributorId,
    side: 'licensor',
    from: 'approved',
    to: 'revoked',
    reason: input.reason,
    event: 'license.revoked',
    after: async (tx, grant) => {
      // An outstanding offer or request must not let the publisher undo the revocation by accepting it.
      const open = await tx.licenseGrant.findMany({ where: { assetId: grant.assetId, licenseeId: grant.licenseeId, status: { in: ['offered', 'requested'] } } });
      for (const g of open) {
        await tx.licenseGrant.update({
          where: { id: g.id },
          data: { status: g.status === 'offered' ? 'withdrawn' : 'declined', closedAt: new Date(), closedById: input.contributorId, closedReason: 'Closed because the license was revoked.' },
        });
        await audit(tx, g.id, g.status === 'offered' ? 'license.withdrawn' : 'license.request_declined', { reason: 'license revoked' });
      }
      // Reports that use the source stop selling immediately (completed sales are unaffected).
      return withdrawReportsUsingAsset(tx, grant.assetId, grant.licenseeId, 'A source license was revoked by its contributor.');
    },
  });
}

async function close(
  db: Db,
  grantId: string,
  o: {
    actorId: string;
    side: 'licensor' | 'licensee';
    from: 'offered' | 'requested' | 'approved';
    to: 'declined' | 'withdrawn' | 'revoked';
    reason?: string | null;
    event: string;
    after?: (tx: Tx, grant: { assetId: string; licenseeId: string }) => Promise<string[]>;
  },
) {
  return db.$transaction(async (tx) => {
    const grant = await tx.licenseGrant.findUnique({ where: { id: grantId }, include: { asset: { select: { ownerId: true } } } });
    const party = grant && (o.side === 'licensor' ? grant.asset.ownerId : grant.licenseeId);
    if (!grant || party !== o.actorId) throw new LicenseError('License not found.', 'not_found');
    await lockPair(tx, grant.assetId, grant.licenseeId);
    const fresh = await tx.licenseGrant.findUniqueOrThrow({ where: { id: grantId } });
    if (fresh.status !== o.from) throw new LicenseError(`This license is ${fresh.status}.`, 'state');
    const updated = await tx.licenseGrant.update({
      where: { id: grantId },
      data: { status: o.to, closedAt: new Date(), closedById: o.actorId, closedReason: o.reason?.trim().slice(0, 500) || null },
    });
    const withdrawn = o.after ? await o.after(tx, updated) : [];
    await audit(tx, grantId, o.event, { from: o.from, to: o.to, reason: updated.closedReason, ...(o.after ? { reportsWithdrawn: withdrawn } : {}) });
    return updated;
  });
}
