import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { BuildIntentSchema } from '@tracepay/shared';
import type { AppDeps } from '../app';
import { currentUser, requireRole } from '../http/auth';
import { HttpError } from '../http/errors';
import { quotas } from '../http/limits';
import { buildReceipt } from '../modules/audit/receipt.service';
import { publicKeyPem, verifyDocument } from '../modules/audit/signing';
import { appendAudit } from '../modules/audit/audit-log';
import { checkSaleRights, withdrawArtifact } from '../modules/sales/rights.service';
import { DEMO_IDS } from '../modules/demo/world';
import { preflightAndRecord } from '../modules/builds/preflight.service';
import { listCatalog } from '../modules/catalog/catalog.service';
import { generateArtifact, type ArtifactContent } from '../modules/generation/generation.service';
import { getProvenance, type ProvenanceGraph } from '../modules/provenance/provenance.service';
import type { Viewer } from '../modules/audit/receipt.service';
import { artifactAccess, ownedBuild, publisherScope, requireArtifactAccess, type ArtifactAccess } from '../http/access';

const PreflightBody = z.object({
  intent: BuildIntentSchema,
  assetVersionIds: z.array(z.string().min(1)).max(20),
});

const VerifyReceiptBody = z.object({
  document: z.record(z.string(), z.unknown()),
  signature: z.string().min(1).max(200),
  /** Ignored (always TracePay's key); accepted so older clients keep working. */
  publicKeyPem: z.string().max(4000).optional(),
});

const param = (req: Request, name: string) => z.string().min(1).max(64).parse(req.params[name]);

export function buildRoutes({ db, signingKeys, writer }: AppDeps) {
  const r = Router();
  const viewerOf = viewerOfFactory(db);

  r.get('/catalog', requireRole('publisher', 'admin'), async (req, res) => {
    const user = currentUser(req);
    // Admins inspect the demo publisher's catalog.
    res.json({ assets: await listCatalog(db, user.role === 'publisher' ? user.id : DEMO_IDS.publisher) });
  });

  r.post('/builds/preflight', requireRole('publisher'), quotas.preflight(), async (req, res) => {
    const body = PreflightBody.parse(req.body);
    const outcome = await db.$transaction((tx) =>
      preflightAndRecord(tx, { publisherId: currentUser(req).id, intent: body.intent, assetVersionIds: body.assetVersionIds }),
    );
    res.status(201).json(outcome);
  });

  r.get('/builds', requireRole('publisher', 'admin'), async (req, res) => {
    const builds = await db.buildJob.findMany({
      where: publisherScope(currentUser(req)),
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, status: true, createdAt: true, intent: true, snapshotHash: true, agentRunId: true, artifact: { select: { id: true } }, sources: { select: { assetVersionId: true } } },
    });
    res.json({ builds });
  });

  r.get('/builds/:id', requireRole('publisher', 'admin'), async (req, res) => {
    const { id } = await ownedBuild(db, currentUser(req), param(req, 'id'));
    // Explicit fields only: a build (even a blocked one) must never expose source
    // content or contributors' payout addresses.
    const build = await db.buildJob.findUnique({
      where: { id },
      select: {
        id: true, status: true, intent: true, asOf: true, preflight: true, policyVersion: true, snapshotHash: true, agentRunId: true, createdAt: true,
        artifact: { select: { id: true } },
        sources: {
          orderBy: { ordinal: 'asc' },
          select: {
            ordinal: true, assetVersionId: true, licenseGrantId: true,
            assetVersion: { select: { version: true, sha256: true, asset: { select: { id: true, title: true, kind: true, owner: { select: { name: true } } } } } },
          },
        },
      },
    });
    if (!build) throw new HttpError(404, 'Build not found.');
    res.json({ build });
  });

  r.post('/builds/:id/generate', requireRole('publisher'), async (req, res) => {
    const { id } = await ownedBuild(db, currentUser(req), param(req, 'id'));
    const result = await generateArtifact(db, id, writer());
    res.status(result.artifactId ? 201 : 422).json(result);
  });

  /** Storefront: listed artifacts with a preview only. */
  r.get('/artifacts', async (_req, res) => {
    const artifacts = await db.artifact.findMany({ where: { status: 'listed' }, orderBy: { createdAt: 'desc' }, take: 100 });
    res.json({ artifacts: artifacts.map((a) => preview(a)) });
  });

  r.get('/artifacts/:id', async (req, res) => {
    const id = param(req, 'id');
    const level = await artifactAccess(db, req.user, id);
    const artifact = await db.artifact.findUniqueOrThrow({ where: { id } });
    // Contributors verify their royalty via provenance and receipt; the paid content is for owner and buyers.
    const full = level === 'owner' || level === 'buyer';
    res.json({ artifact: full ? { ...preview(artifact), content: artifact.content, citationReport: artifact.citationReport, purchased: level === 'buyer' } : preview(artifact), full, access: level });
  });

  r.get('/artifacts/:id/provenance', requireRole('publisher', 'admin', 'contributor', 'buyer'), async (req, res) => {
    const id = param(req, 'id');
    const level = await requireArtifactAccess(db, req.user, id, ['owner', 'buyer', 'contributor']);
    const graph = await getProvenance(db, id);
    if (!graph) throw new HttpError(404, 'Report not found.');
    res.json(redactGraph(graph, level, await viewerOf(req, id)));
  });

  r.get('/artifacts/:id/receipt', requireRole('publisher', 'admin', 'contributor', 'buyer'), async (req, res) => {
    const id = param(req, 'id');
    const level = await requireArtifactAccess(db, req.user, id, ['owner', 'buyer', 'contributor']);
    const receipt = await buildReceipt(db, id, signingKeys(), { level, ...(await viewerOf(req, id)) });
    if (!receipt) throw new HttpError(404, 'Artifact not found.');
    res.json(receipt);
  });

  /** The publisher's own reports in every status, with why any were taken off sale. */
  r.get('/reports', requireRole('publisher', 'admin'), async (req, res) => {
    const artifacts = await db.artifact.findMany({
      where: { buildJob: publisherScope(currentUser(req)) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const withdrawals = await db.auditEvent.findMany({
      where: { eventType: 'artifact.withdrawn', artifactId: { in: artifacts.filter((a) => a.status === 'withdrawn').map((a) => a.id) } },
      orderBy: { seq: 'desc' },
      select: { artifactId: true, payload: true },
    });
    const reasonOf = new Map<string, string>();
    for (const w of withdrawals) {
      if (w.artifactId && !reasonOf.has(w.artifactId)) reasonOf.set(w.artifactId, ((w.payload as { reasons?: string[] }).reasons ?? [])[0] ?? '');
    }
    res.json({ reports: artifacts.map((a) => ({ ...preview(a), withdrawnReason: reasonOf.get(a.id) ?? null })) });
  });

  /** The publisher takes a report off sale. */
  r.post('/artifacts/:id/withdraw', requireRole('publisher', 'admin'), async (req, res) => {
    const id = param(req, 'id');
    await requireArtifactAccess(db, req.user, id, ['owner']);
    await db.$transaction((tx) => withdrawArtifact(tx, id, ['Withdrawn by the publisher.'], 'publisher'));
    res.json({ ok: true });
  });

  /** Puts a report back on sale — only if every source license still permits it today. */
  r.post('/artifacts/:id/relist', requireRole('publisher', 'admin'), async (req, res) => {
    const id = param(req, 'id');
    await requireArtifactAccess(db, req.user, id, ['owner']);
    const result = await db.$transaction(async (tx) => {
      const artifact = await tx.artifact.findUniqueOrThrow({ where: { id }, include: { buildJob: { select: { intent: true } } } });
      if ((artifact.buildJob.intent as { distribution?: string }).distribution !== 'sale') throw new HttpError(409, 'This report was built for internal use only.');
      if (artifact.status === 'listed') return { ok: true as const };
      const rights = await checkSaleRights(tx, id);
      if (!rights.ok) return { ok: false as const, reasons: rights.reasons };
      await tx.artifact.update({ where: { id }, data: { status: 'listed' } });
      await appendAudit(tx, { entityType: 'artifact', entityId: id, artifactId: id, eventType: 'artifact.relisted', payload: {} });
      return { ok: true as const };
    });
    if (!result.ok) throw new HttpError(409, `It can't be sold yet: ${result.reasons[0]}`, { reasons: result.reasons });
    res.json({ ok: true });
  });

  /** Anyone can check a receipt; by default against this server's public key. */
  r.post('/receipts/verify', async (req, res) => {
    const body = VerifyReceiptBody.parse(req.body);
    // Always TracePay's own key: a receipt forged with someone else's key (and carrying that
    // key) must not verify. To check against another key, verify offline with the receipt.
    const pem = publicKeyPem(signingKeys());
    let valid = false;
    try {
      valid = verifyDocument(body.document, body.signature, pem);
    } catch {
      valid = false;
    }
    res.json({ valid, signedBy: valid ? 'TracePay' : null, keyFingerprint: createHash('sha256').update(pem).digest('hex').slice(0, 16) });
  });

  return r;
}

function preview(a: { id: string; title: string; priceCents: number; currency: string; status: string; model: string; fromFixture: boolean; contentHash: string; createdAt: Date; content: unknown }) {
  const c = a.content as ArtifactContent;
  return {
    id: a.id,
    title: a.title,
    priceCents: a.priceCents,
    currency: a.currency,
    status: a.status,
    model: a.model,
    fromFixture: a.fromFixture,
    contentHash: a.contentHash,
    createdAt: a.createdAt,
    summary: c.sections.find((s) => s.key === 'summary')?.body ?? null,
    sectionHeadings: c.sections.map((s) => s.heading),
    sources: c.sources.map((s) => ({ title: s.assetTitle, cited: s.cited })),
    credits: c.credits.map((x) => x.text),
  };
}

/** Who is looking, and which of this report's sources are theirs. */
function viewerOfFactory(db: AppDeps['db']) {
  return async (req: Request, artifactId: string): Promise<Viewer> => {
    const userId = req.user?.id ?? '';
    const own = await db.buildSource.findMany({
      where: { buildJob: { artifact: { id: artifactId } }, assetVersion: { asset: { ownerId: userId } } },
      select: { assetVersionId: true },
    });
    return { userId, ownAssetVersionIds: new Set(own.map((o) => o.assetVersionId)) };
  };
}

/**
 * Each viewer gets the graph they're entitled to:
 *  - owner: everything;
 *  - buyer: how the report was sourced — cited passages only, shortened — but not the money split;
 *  - contributor: their own sources, passages and royalty lines; no report text and no
 *    other contributor's terms, passages or payouts.
 */
function redactGraph(graph: ProvenanceGraph, level: ArtifactAccess, viewer: Viewer): ProvenanceGraph {
  if (level === 'owner') return graph;
  const cited = new Set(graph.edges.filter((e) => e.kind === 'supports_claim').map((e) => e.source));
  const passageSource = new Map(graph.edges.filter((e) => e.kind === 'contains').map((e) => [e.target, e.source.replace(/^source:/, '')]));
  const lineOwner = new Map(graph.nodes.filter((n) => n.kind === 'settlement_line').map((n) => [n.id, String(n.data.recipientId)]));
  const payoutLine = new Map(graph.edges.filter((e) => e.kind === 'paid_via').map((e) => [e.target, e.source]));

  const keep = (n: ProvenanceGraph['nodes'][number]): boolean => {
    if (level === 'buyer') {
      if (n.kind === 'settlement_line' || n.kind === 'payout') return false;
      if (n.kind === 'passage') return cited.has(n.id);
      return true;
    }
    // contributor
    if (n.kind === 'passage') return viewer.ownAssetVersionIds.has(passageSource.get(n.id) ?? '');
    if (n.kind === 'settlement_line') return lineOwner.get(n.id) === viewer.userId;
    if (n.kind === 'payout') return lineOwner.get(payoutLine.get(n.id) ?? '') === viewer.userId;
    return true;
  };
  const shorten = (t: unknown) => (typeof t === 'string' && t.length > 240 ? `${t.slice(0, 237)}…` : t);

  const nodes = graph.nodes.filter(keep).map((n) => {
    const data: Record<string, unknown> = { ...n.data };
    if (n.kind === 'payout') delete data.receiver;
    if (n.kind === 'passage' && level === 'buyer') data.text = shorten(data.text);
    if (n.kind === 'section' && level === 'contributor') delete data.body;
    if (n.kind === 'source' && !(level === 'contributor' && viewer.ownAssetVersionIds.has(String(data.assetVersionId)))) {
      // Other parties' commercial terms are confidential.
      delete data.economics;
      delete data.payableOn;
      delete data.licenseId;
    }
    return { ...n, data };
  });
  const ids = new Set(nodes.map((n) => n.id));
  return { ...graph, nodes, edges: graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
}
