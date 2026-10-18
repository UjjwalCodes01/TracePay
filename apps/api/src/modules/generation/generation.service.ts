import type { BuildIntent, PreflightReport } from '@tracepay/shared';
import type { Prisma } from '../../generated/prisma/client';
import type { Db } from '../../db';
import { appendAudit } from '../audit/audit-log';
import { canonicalJson, sha256Hex } from '../audit/hash-chain';
import { validateCitations, type CitationReport, type DraftSection } from './citations';
import { retrievePassages } from './retrieval';
import { pickWriter, type ReportWriter } from './writers';

export class BuildStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildStateError';
  }
}

export interface ArtifactContent {
  title: string;
  sections: DraftSection[];
  credits: Array<{ assetVersionId: string; assetTitle: string; text: string }>;
  sources: Array<{ assetVersionId: string; assetTitle: string; version: number; sha256: string; cited: boolean }>;
}

export interface GenerationResult {
  buildId: string;
  artifactId: string | null;
  citationReport: CitationReport;
  attempts: number;
  model: string;
  fromFixture: boolean;
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

/**
 * Generates the deliverable for a build that passed preflight.
 *  1. claim the build (preflight_passed → generating) so it can't run twice;
 *  2. retrieve passages from the approved, pinned source versions only;
 *  3. have the writer draft with [Cn] markers; validate every marker against
 *     the retrieval record (one repair attempt);
 *  4. persist artifact, citations, retrieval/citation events and audit atomically.
 * The model call happens outside any database transaction.
 */
export async function generateArtifact(db: Db, buildId: string, writer: ReportWriter = pickWriter()): Promise<GenerationResult> {
  const claimed = await db.buildJob.updateMany({ where: { id: buildId, status: 'preflight_passed' }, data: { status: 'generating' } });
  if (claimed.count === 0) {
    const build = await db.buildJob.findUnique({ where: { id: buildId }, select: { status: true } });
    if (!build) throw new BuildStateError(`Build ${buildId} not found.`);
    throw new BuildStateError(`Build ${buildId} is ${build.status}; only a build that passed preflight can be generated.`);
  }

  try {
    const build = await db.buildJob.findUniqueOrThrow({
      where: { id: buildId },
      include: { sources: { orderBy: { ordinal: 'asc' }, include: { assetVersion: { include: { asset: true } } } } },
    });
    const intent = build.intent as unknown as BuildIntent;
    const preflight = build.preflight as unknown as PreflightReport;
    const titleOf = new Map(build.sources.map((s) => [s.assetVersionId, s.assetVersion.asset.title]));

    const passages = (await retrievePassages(db, build.sources.map((s) => s.assetVersionId), `${intent.title} ${intent.brief}`)).map(
      (p) => ({ ...p, sourceTitle: titleOf.get(p.assetVersionId) ?? p.assetVersionId }),
    );
    await db.sourceEvent.createMany({
      data: passages.map((p) => ({ buildJobId: buildId, assetVersionId: p.assetVersionId, chunkId: p.chunkId, eventType: 'retrieved' as const, handle: p.handle })),
    });

    let attempts = 0;
    let draft = await writer.write({ intent, passages });
    attempts++;
    let report = validateCitations(draft.sections, passages);
    if (!report.ok && !draft.fromFixture) {
      draft = await writer.write({ intent, passages, previousErrors: report.errors });
      attempts++;
      report = validateCitations(draft.sections, passages);
    }

    if (!report.ok) {
      await db.$transaction(async (tx) => {
        await tx.buildJob.update({ where: { id: buildId }, data: { status: 'generation_failed' } });
        await appendAudit(tx, {
          entityType: 'build',
          entityId: buildId,
          eventType: 'build.generation_rejected',
          payload: { attempts, model: draft.model, errors: report.errors },
        });
      });
      return { buildId, artifactId: null, citationReport: report, attempts, model: draft.model, fromFixture: draft.fromFixture };
    }

    const cited = new Set(report.citedAssetVersionIds);
    const content: ArtifactContent = {
      title: intent.title,
      sections: draft.sections,
      // Attribution is added deterministically from the approved obligations, never left to the model.
      credits: preflight.obligations.map((o) => ({ assetVersionId: o.assetVersionId, assetTitle: o.assetTitle, text: o.text })),
      sources: build.sources.map((s) => ({
        assetVersionId: s.assetVersionId,
        assetTitle: s.assetVersion.asset.title,
        version: s.assetVersion.version,
        sha256: s.assetVersion.sha256,
        cited: cited.has(s.assetVersionId),
      })),
    };
    const contentHash = sha256Hex(canonicalJson(content));

    const artifactId = await db.$transaction(async (tx) => {
      const artifact = await tx.artifact.create({
        data: {
          buildJobId: buildId,
          title: intent.title,
          content: json(content),
          contentHash,
          priceCents: intent.priceCents,
          currency: intent.currency,
          status: intent.distribution === 'sale' ? 'listed' : 'draft',
          citationReport: json(report),
          model: draft.model,
          fromFixture: draft.fromFixture,
          citations: {
            create: report.citations.map((c) => ({ sectionKey: c.sectionKey, handle: c.handle, chunkId: c.chunkId, assetVersionId: c.assetVersionId })),
          },
        },
      });
      await tx.sourceEvent.createMany({
        data: report.citations.map((c) => ({ buildJobId: buildId, assetVersionId: c.assetVersionId, chunkId: c.chunkId, eventType: 'cited' as const, handle: c.handle })),
      });
      await tx.buildJob.update({ where: { id: buildId }, data: { status: 'generated' } });
      await appendAudit(tx, {
        entityType: 'artifact',
        entityId: artifact.id,
        artifactId: artifact.id,
        eventType: 'artifact.generated',
        payload: {
          buildId,
          buildSnapshotHash: build.snapshotHash,
          contentHash,
          model: draft.model,
          fromFixture: draft.fromFixture,
          attempts,
          retrieved: passages.length,
          citations: report.citations.length,
          citedAssetVersionIds: report.citedAssetVersionIds,
          retrievedNotCitedAssetVersionIds: report.retrievedNotCitedAssetVersionIds,
        },
      });
      return artifact.id;
    });

    return { buildId, artifactId, citationReport: report, attempts, model: draft.model, fromFixture: draft.fromFixture };
  } catch (err) {
    await db.buildJob.updateMany({ where: { id: buildId, status: 'generating' }, data: { status: 'generation_failed' } });
    throw err;
  }
}
