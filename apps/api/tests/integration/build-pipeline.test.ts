import { beforeEach, describe, expect, it } from 'vitest';
import type { BuildIntent } from '@tracepay/shared';
import { db } from '../../src/db';
import { verifyAuditChain } from '../../src/modules/audit/audit-log';
import { listCatalog } from '../../src/modules/catalog/catalog.service';
import { preflightAndRecord } from '../../src/modules/builds/preflight.service';
import { BuildStateError, generateArtifact, type ArtifactContent } from '../../src/modules/generation/generation.service';
import { FixtureReportWriter, type ReportWriter } from '../../src/modules/generation/writers';
import { resetAndSeed } from '../../src/modules/demo/seed';
import { DEMO_IDS } from '../../src/modules/demo/world';

const AS_OF = '2026-10-18';
const A = 'asset_northwind_index_v1';
const B = 'asset_okafor_notes_v1';
const C = 'asset_kestrel_panel_v1';
const D = 'asset_lumen_digest_v1';
const E = 'asset_ide_pricing_v1';

const intent: BuildIntent = {
  title: 'Developer Tools Market Brief, Q4 2026',
  brief: 'Market intelligence on developer-tools spend, AI coding assistant adoption, pricing and licensing concerns.',
  purpose: 'commercial_report',
  distribution: 'sale',
  includesRawData: false,
  territory: 'US',
  priceCents: 2000,
  currency: 'USD',
};

const preflight = (ids: string[]) =>
  db().$transaction((tx) => preflightAndRecord(tx, { publisherId: DEMO_IDS.publisher, intent, assetVersionIds: ids, asOf: AS_OF }));

describe.runIf(process.env.TEST_DATABASE_URL)('build pipeline (integration)', () => {
  beforeEach(async () => {
    await resetAndSeed(db());
  });

  it('lists the catalog with each asset’s governing license', async () => {
    const catalog = await listCatalog(db(), DEMO_IDS.publisher);
    expect(catalog).toHaveLength(5);
    expect(catalog.find((c) => c.assetVersionId === C)?.license?.terms.allowedPurposes).toEqual(['internal_research']);
  });

  it('records a blocked build, then a passing replacement build', async () => {
    const blocked = await preflight([A, B, C]);
    expect(blocked.report.verdict).toBe('block');
    const blockedRow = await db().buildJob.findUniqueOrThrow({ where: { id: blocked.buildId } });
    expect(blockedRow.status).toBe('preflight_blocked');

    const passed = await preflight([A, B, D]);
    expect(passed.report.verdict).toBe('pass');
    expect(passed.snapshotHash).not.toBe(blocked.snapshotHash);

    const expired = await preflight([A, E]);
    expect(expired.report.results.filter((r) => r.outcome === 'fail').map((r) => r.ruleId)).toEqual(['LICENSE_IN_TERM']);
  });

  it('refuses to generate a blocked build', async () => {
    const { buildId } = await preflight([A, C]);
    await expect(generateArtifact(db(), buildId, new FixtureReportWriter())).rejects.toBeInstanceOf(BuildStateError);
  });

  it('generates a cited artifact with deterministic attribution and a valid audit chain', async () => {
    const { buildId } = await preflight([A, B, D]);
    const result = await generateArtifact(db(), buildId, new FixtureReportWriter());
    expect(result.artifactId).not.toBeNull();
    expect(result.fromFixture).toBe(true);
    expect(result.citationReport.ok).toBe(true);

    const artifact = await db().artifact.findUniqueOrThrow({ where: { id: result.artifactId! }, include: { citations: true } });
    const content = artifact.content as unknown as ArtifactContent;
    expect(content.credits.map((c) => c.text)).toEqual(['Field research by Mara Okafor, independent analyst']);
    expect(content.sources.map((s) => s.assetVersionId)).toEqual([A, B, D]);
    expect(artifact.citations.length).toBeGreaterThan(0);
    expect(artifact.status).toBe('listed');
    expect(artifact.priceCents).toBe(2000);

    // Every citation points at a chunk that was actually retrieved for this build.
    const retrieved = await db().sourceEvent.findMany({ where: { buildJobId: buildId, eventType: 'retrieved' } });
    const retrievedChunks = new Set(retrieved.map((r) => r.chunkId));
    for (const c of artifact.citations) expect(retrievedChunks.has(c.chunkId)).toBe(true);

    // Retrieval never touches sources outside the build.
    expect(new Set(retrieved.map((r) => r.assetVersionId))).toEqual(new Set([A, B, D]));

    await expect(generateArtifact(db(), buildId, new FixtureReportWriter())).rejects.toBeInstanceOf(BuildStateError);
    expect(await verifyAuditChain(db())).toMatchObject({ ok: true });
  });

  it('rejects a model that invents a source, after one repair attempt', async () => {
    let calls = 0;
    const hallucinating: ReportWriter = {
      name: 'bad',
      async write() {
        calls++;
        return {
          model: 'test/hallucinating',
          fromFixture: false,
          sections: [{ key: 'finding_1', heading: 'Bold claim', body: 'Spend tripled [C99].', requiresCitation: true }],
        };
      },
    };
    const { buildId } = await preflight([A, B, D]);
    const result = await generateArtifact(db(), buildId, hallucinating);
    expect(calls).toBe(2);
    expect(result.artifactId).toBeNull();
    expect(result.citationReport.errors[0]).toMatchObject({ reason: 'unknown_reference', handle: 'C99' });
    const build = await db().buildJob.findUniqueOrThrow({ where: { id: buildId } });
    expect(build.status).toBe('generation_failed');
  });
});
