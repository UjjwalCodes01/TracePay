import { LicenseTermsSchema } from '@tracepay/shared';
import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { currentUser, requireRole } from '../http/auth';
import { HttpError } from '../http/errors';
import { quotas } from '../http/limits';
import { addVersion, ASSET_KINDS, createAsset, MAX_CONTENT_CHARS } from '../modules/assets/asset.service';
import { todayUtc } from '../modules/builds/preflight.service';
import { extractTerms, MAX_LICENSE_TEXT } from '../modules/licenses/extract';
import { acceptOffer, declineOffer, declineRequest, offerLicense, requestLicense, revokeLicense, withdrawOffer } from '../modules/licenses/license.service';
import { limitStore } from '../http/rate-store';
import { appendAudit } from '../modules/audit/audit-log';
import { logIn } from '../modules/auth/auth.service';

const param = (req: Request, name: string) => z.string().min(1).max(64).parse(req.params[name]);
const Reason = z.object({ reason: z.string().max(500).optional().nullable() });

const GRANT_SELECT = {
  id: true, version: true, status: true, terms: true, termsHash: true, origin: true, requestMessage: true,
  offeredAt: true, approvedAt: true, closedAt: true, closedReason: true, createdAt: true, updatedAt: true,
} as const;

export function licensingRoutes({ db, config }: AppDeps) {
  const r = Router();

  // AI extraction costs money: cap it per signed-in user.
  const extractLimiter = rateLimit({ ...limitStore('license-extract'),
    windowMs: 10 * 60_000,
    limit: 30,
    keyGenerator: (req) => req.user?.id ?? 'anonymous',
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many extraction requests. Try again in a few minutes.' },
  });

  // ---------------------------------------------------------------- profile

  r.patch('/me', async (req, res) => {
    const user = currentUser(req);
    // Shared demo personas: anyone could otherwise point a demo contributor's payouts at themselves.
    if (req.authMethod === 'demo') throw new HttpError(403, 'Demo profiles can’t be changed. Sign up for your own account.');
    const body = z
      .object({
        name: z.string().trim().min(2).max(120).optional(),
        paypalEmail: z.email().max(254).nullable().optional(),
        /** Required to change where payouts go: a stolen session alone can't redirect someone's money. */
        currentPassword: z.string().min(1).max(200).optional(),
      })
      .parse(req.body);
    const current = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { paypalEmail: true } });
    const newPayee = body.paypalEmail === undefined ? undefined : (body.paypalEmail?.toLowerCase() ?? null);
    const payeeChanges = newPayee !== undefined && newPayee !== current.paypalEmail;
    if (payeeChanges) {
      if (req.authMethod !== 'session') throw new HttpError(403, 'Sign in with your password to change where payouts go.');
      if (!body.currentPassword) throw new HttpError(400, 'Enter your current password to change where payouts go.', { code: 'password_required' });
      await logIn(db, user.email, body.currentPassword).catch(() => {
        throw new HttpError(401, 'Your current password is incorrect.');
      });
    }
    const updated = await db.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: user.id },
        data: { ...(body.name ? { name: body.name } : {}), ...(payeeChanges ? { paypalEmail: newPayee } : {}) },
        select: { id: true, name: true, email: true, role: true, paypalEmail: true },
      });
      // Audited without the addresses themselves (the audit log can't be erased; it stays pseudonymous).
      if (payeeChanges) await appendAudit(tx, { entityType: 'user', entityId: user.id, eventType: 'account.payout_email_changed', payload: { hadPayee: !!current.paypalEmail, hasPayee: !!newPayee } });
      return u;
    });
    res.json({ user: updated });
  });

  r.get('/me/profile', async (req, res) => {
    const user = await db.user.findUniqueOrThrow({ where: { id: currentUser(req).id }, select: { id: true, name: true, email: true, role: true, paypalEmail: true } });
    res.json({ user });
  });

  // ---------------------------------------------------------------- contributor: sources

  r.get('/contributor/assets', requireRole('contributor'), async (req, res) => {
    const assets = await db.asset.findMany({
      where: { ownerId: currentUser(req).id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        versions: { orderBy: { version: 'desc' }, select: { id: true, version: true, sha256: true, createdAt: true, _count: { select: { chunks: true } } } },
        licenses: { orderBy: [{ licenseeId: 'asc' }, { version: 'desc' }], select: { ...GRANT_SELECT, licensee: { select: { id: true, name: true, email: true } } } },
      },
    });
    res.json({ assets });
  });

  r.post('/contributor/assets', requireRole('contributor'), quotas.createAsset(), async (req, res) => {
    const body = z
      .object({
        title: z.string().trim().min(3).max(200),
        kind: z.enum(ASSET_KINDS),
        description: z.string().trim().min(10).max(1000),
        content: z.string().max(MAX_CONTENT_CHARS + 10_000),
      })
      .parse(req.body);
    const created = await createAsset(db, currentUser(req).id, body);
    res.status(201).json({ assetId: created.asset.id, assetVersionId: created.version.id, chunks: created.chunks });
  });

  /** Archiving hides a source from the marketplace; existing licenses keep working until revoked. */
  r.post('/contributor/assets/:id/archive', requireRole('contributor'), async (req, res) => {
    const { archived } = z.object({ archived: z.boolean() }).parse(req.body);
    const result = await db.asset.updateMany({ where: { id: param(req, 'id'), ownerId: currentUser(req).id }, data: { archivedAt: archived ? new Date() : null } });
    if (result.count === 0) throw new HttpError(404, 'Source not found.');
    res.json({ ok: true, archived });
  });

  r.post('/contributor/assets/:id/versions', requireRole('contributor'), quotas.addVersion(), async (req, res) => {
    const { content } = z.object({ content: z.string().max(MAX_CONTENT_CHARS + 10_000) }).parse(req.body);
    const created = await addVersion(db, currentUser(req).id, param(req, 'id'), content);
    res.status(201).json({ assetVersionId: created.version.id, version: created.version.version, chunks: created.chunks });
  });

  // ---------------------------------------------------------------- licenses: drafting

  /** Drafts normalized terms from a license document. Nothing is saved or enforced. */
  r.post('/licenses/extract', requireRole('contributor', 'publisher'), extractLimiter, async (req, res) => {
    const { text } = z.object({ text: z.string().trim().min(20, 'Paste the license text (at least a sentence or two).').max(MAX_LICENSE_TEXT) }).parse(req.body);
    res.json(await extractTerms(text, { useModel: config.vertexReady, today: todayUtc() }));
  });

  r.post('/contributor/assets/:id/offers', requireRole('contributor'), quotas.offer(), async (req, res) => {
    const body = z
      .object({
        licenseeEmail: z.email(),
        terms: LicenseTermsSchema,
        origin: z.enum(['manual', 'ai_draft', 'rules_draft']).default('manual'),
        sourceText: z.string().max(MAX_LICENSE_TEXT).optional().nullable(),
        // Kept for comparison only; bounded so it can't be used to store arbitrary blobs.
        extraction: z.unknown().optional().refine((v) => JSON.stringify(v ?? null).length <= 50_000, 'Extraction data is too large.'),
      })
      .parse(req.body);
    const licensee = await db.user.findUnique({ where: { email: body.licenseeEmail.toLowerCase() }, select: { id: true, role: true } });
    // Same answer for 'no account' and 'not a publisher', so the form can't be used to probe accounts.
    if (!licensee || licensee.role !== 'publisher') throw new HttpError(404, 'No publisher account uses that email.');
    const grant = await offerLicense(db, {
      assetId: param(req, 'id'),
      contributorId: currentUser(req).id,
      licenseeId: licensee.id,
      terms: body.terms,
      origin: body.origin,
      sourceText: body.sourceText,
      extraction: body.extraction,
    });
    res.status(201).json({ license: { id: grant.id, version: grant.version, status: grant.status, termsHash: grant.termsHash } });
  });

  r.post('/licenses/:id/withdraw', requireRole('contributor'), async (req, res) => {
    const { reason } = Reason.parse(req.body);
    res.json({ license: await withdrawOffer(db, { grantId: param(req, 'id'), contributorId: currentUser(req).id, reason }) });
  });

  r.post('/licenses/:id/decline-request', requireRole('contributor'), async (req, res) => {
    const { reason } = Reason.parse(req.body);
    res.json({ license: await declineRequest(db, { grantId: param(req, 'id'), contributorId: currentUser(req).id, reason }) });
  });

  r.post('/licenses/:id/revoke', requireRole('contributor'), async (req, res) => {
    const { reason } = Reason.parse(req.body);
    res.json({ license: await revokeLicense(db, { grantId: param(req, 'id'), contributorId: currentUser(req).id, reason }) });
  });

  // ---------------------------------------------------------------- publisher: marketplace & offers

  /** Source listings: descriptions only — content stays private until licensed. */
  r.get('/marketplace', requireRole('publisher'), async (req, res) => {
    const me = currentUser(req).id;
    const assets = await db.asset.findMany({
      where: { ownerId: { not: me }, archivedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true, title: true, kind: true, description: true, createdAt: true,
        owner: { select: { id: true, name: true } },
        versions: { orderBy: { version: 'desc' }, take: 1, select: { version: true, _count: { select: { chunks: true } } } },
        licenses: { where: { licenseeId: me }, orderBy: { version: 'desc' }, take: 20, select: { id: true, status: true, version: true, terms: true } },
      },
    });
    res.json({
      sources: assets.map((a) => ({
        assetId: a.id,
        title: a.title,
        kind: a.kind,
        description: a.description,
        owner: a.owner,
        version: a.versions[0]?.version ?? 0,
        passages: a.versions[0]?._count.chunks ?? 0,
        // The license in force, if any — a newer offer that was declined or withdrawn
        // doesn't end it — otherwise the newest one.
        myLicense: a.licenses.find((l) => l.status === 'approved') ?? a.licenses[0] ?? null,
        // A newer offer or request still open next to the license in force.
        pendingLicense: a.licenses.find((l) => l.status === 'approved') ? (a.licenses.find((l) => l.status === 'offered' || l.status === 'requested') ?? null) : null,
      })),
    });
  });

  r.post('/marketplace/:assetId/request', requireRole('publisher'), quotas.request(), async (req, res) => {
    const { message } = z.object({ message: z.string().max(1000).optional().nullable() }).parse(req.body);
    const grant = await requestLicense(db, { assetId: param(req, 'assetId'), publisherId: currentUser(req).id, message });
    res.status(201).json({ license: { id: grant.id, status: grant.status, version: grant.version } });
  });

  /** Offers waiting for this publisher's decision, plus their open requests. */
  r.get('/licenses/inbox', requireRole('publisher'), async (req, res) => {
    const grants = await db.licenseGrant.findMany({
      where: { licenseeId: currentUser(req).id, status: { in: ['offered', 'requested'] } },
      take: 100,
      orderBy: { updatedAt: 'desc' },
      select: { ...GRANT_SELECT, sourceText: true, asset: { select: { id: true, title: true, kind: true, owner: { select: { name: true, paypalEmail: true } } } } },
    });
    // For renegotiations, show what is in force today next to what is offered.
    const current = await db.licenseGrant.findMany({
      where: { licenseeId: currentUser(req).id, status: 'approved', assetId: { in: grants.map((g) => g.asset.id) } },
      select: { assetId: true, version: true, terms: true },
    });
    const byAsset = new Map(current.map((c) => [c.assetId, c]));
    // Never expose the contributor's payout address — only whether one is set.
    res.json({
      licenses: grants.map(({ asset: { owner, ...asset }, ...g }) => ({
        ...g,
        asset: { ...asset, owner: { name: owner.name, canBePaid: Boolean(owner.paypalEmail) } },
        current: byAsset.get(asset.id) ?? null,
      })),
    });
  });

  r.post('/licenses/:id/accept', requireRole('publisher'), async (req, res) => {
    const { termsHash } = z.object({ termsHash: z.string().length(64) }).parse(req.body);
    res.json({ license: await acceptOffer(db, { grantId: param(req, 'id'), publisherId: currentUser(req).id, termsHash }) });
  });

  r.post('/licenses/:id/decline', requireRole('publisher'), async (req, res) => {
    const { reason } = Reason.parse(req.body);
    res.json({ license: await declineOffer(db, { grantId: param(req, 'id'), publisherId: currentUser(req).id, reason }) });
  });

  return r;
}
