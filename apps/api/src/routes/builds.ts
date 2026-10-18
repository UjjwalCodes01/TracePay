import { Router, type Request } from 'express';
import { z } from 'zod';
import { BuildIntentSchema } from '@tracepay/shared';
import type { AppDeps } from '../app';
import { currentUser, requireRole } from '../http/auth';
import { HttpError } from '../http/errors';
import { buildReceipt } from '../modules/audit/receipt.service';
import { publicKeyPem, verifyDocument } from '../modules/audit/signing';
import { DEMO_IDS } from '../modules/demo/world';
import { preflightAndRecord } from '../modules/builds/preflight.service';
import { listCatalog } from '../modules/catalog/catalog.service';
import { generateArtifact, type ArtifactContent } from '../modules/generation/generation.service';
import { getProvenance, type ProvenanceGraph } from '../modules/provenance/provenance.service';
import { artifactAccess, ownedBuild, publisherScope, requireArtifactAccess, type ArtifactAccess } from '../http/access';

const PreflightBody = z.object({
  intent: BuildIntentSchema,
  assetVersionIds: z.array(z.string().min(1)).max(20),
});

const VerifyReceiptBody = z.object({
  document: z.record(z.string(), z.unknown()),
  signature: z.string().min(1),
  publicKeyPem: z.string().min(1).optional(),
});

const param = (req: Request, name: string) => z.string().min(1).max(64).parse(req.params[name]);

export function buildRoutes({ db, signingKeys, writer }: AppDeps) {
  const r = Router();

  r.get('/catalog', requireRole('publisher', 'admin'), async (req, res) => {
    const user = currentUser(req);
    // Admins inspect the demo publisher's catalog.
    res.json({ assets: await listCatalog(db, user.role === 'publisher' ? user.id : DEMO_IDS.publisher) });
  });

  r.post('/builds/preflight', requireRole('publisher'), async (req, res) => {
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
    const build = await db.buildJob.findUnique({
      where: { id },
      include: { sources: { orderBy: { ordinal: 'asc' }, include: { assetVersion: { include: { asset: true } } } }, artifact: { select: { id: true } } },
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
    const artifacts = await db.artifact.findMany({ where: { status: 'listed' }, orderBy: { createdAt: 'desc' } });
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
    res.json(redactGraph(graph, level));
  });

  r.get('/artifacts/:id/receipt', requireRole('publisher', 'admin', 'contributor', 'buyer'), async (req, res) => {
    const id = param(req, 'id');
    await requireArtifactAccess(db, req.user, id, ['owner', 'buyer', 'contributor']);
    const receipt = await buildReceipt(db, id, signingKeys());
    if (!receipt) throw new HttpError(404, 'Artifact not found.');
    res.json(receipt);
  });

  /** Anyone can check a receipt; by default against this server's public key. */
  r.post('/receipts/verify', async (req, res) => {
    const body = VerifyReceiptBody.parse(req.body);
    const pem = body.publicKeyPem ?? publicKeyPem(signingKeys());
    let valid = false;
    try {
      valid = verifyDocument(body.document, body.signature, pem);
    } catch {
      valid = false;
    }
    res.json({ valid });
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

/**
 * Buyers see how the report was sourced but not how the money was split;
 * nobody but the owner sees contributors' payout addresses.
 */
function redactGraph(graph: ProvenanceGraph, level: ArtifactAccess): ProvenanceGraph {
  if (level === 'owner') return graph;
  const hidden = new Set(level === 'buyer' ? graph.nodes.filter((n) => n.kind === 'settlement_line' || n.kind === 'payout').map((n) => n.id) : []);
  return {
    ...graph,
    nodes: graph.nodes
      .filter((n) => !hidden.has(n.id))
      .map((n) => (n.kind === 'payout' ? { ...n, data: { ...n.data, receiver: undefined } } : n)),
    edges: graph.edges.filter((e) => !hidden.has(e.source) && !hidden.has(e.target)),
  };
}
