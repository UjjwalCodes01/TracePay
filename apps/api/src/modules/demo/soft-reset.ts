import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Prisma } from '../../generated/prisma/client';
import type { Db } from '../../db';
import { appendAudit } from '../audit/audit-log';
import { canonicalJson, sha256Hex } from '../audit/hash-chain';
import { chunkContent, DEMO_ASSETS, DEMO_IDS, DEMO_USERS } from './world';

const FIXTURE_DIR = process.env.DEMO_FIXTURE_DIR ?? path.resolve(process.cwd(), 'fixtures/demo-assets');
const payeeEmails = () =>
  (process.env.DEMO_PAYEE_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);

export const DEMO_EMAILS = new Set(DEMO_USERS.map((u) => u.email.toLowerCase()));

/**
 * The in-app "Reset demo". Unlike the developer seed (which truncates every
 * table), this only touches the demo publisher's own work and restores the demo
 * fixtures. Real accounts — and everything they built, bought or licensed —
 * are never deleted. The audit chain is never rewritten either.
 */
export async function softResetDemo(db: Db): Promise<{ removedBuilds: number; removedSales: number }> {
  const publisherIds = DEMO_USERS.filter((u) => u.role === 'publisher').map((u) => u.id);
  const payees = payeeEmails();
  const contents = await Promise.all(DEMO_ASSETS.map((a) => readFile(path.join(FIXTURE_DIR, a.file), 'utf8')));

  return db.$transaction(
    async (tx) => {
      // 1. The demo publisher's work and everything downstream of it.
      const buildIds = (await tx.buildJob.findMany({ where: { publisherId: { in: publisherIds } }, select: { id: true } })).map((b) => b.id);
      const artifactIds = (await tx.artifact.findMany({ where: { buildJobId: { in: buildIds } }, select: { id: true } })).map((a) => a.id);
      const saleIds = (await tx.sale.findMany({ where: { artifactId: { in: artifactIds } }, select: { id: true } })).map((s) => s.id);
      const runIds = (await tx.settlementRun.findMany({ where: { saleId: { in: saleIds } }, select: { id: true } })).map((r) => r.id);

      await tx.payoutItem.deleteMany({ where: { batch: { runId: { in: runIds } } } });
      await tx.payoutBatch.deleteMany({ where: { runId: { in: runIds } } });
      await tx.settlementLine.deleteMany({ where: { runId: { in: runIds } } });
      await tx.settlementRun.deleteMany({ where: { id: { in: runIds } } });
      await tx.payPalPayment.deleteMany({ where: { saleId: { in: saleIds } } });
      await tx.sale.deleteMany({ where: { id: { in: saleIds } } });
      await tx.artifactCitation.deleteMany({ where: { artifactId: { in: artifactIds } } });
      await tx.artifact.deleteMany({ where: { id: { in: artifactIds } } });
      await tx.sourceEvent.deleteMany({ where: { buildJobId: { in: buildIds } } });
      await tx.buildSource.deleteMany({ where: { buildJobId: { in: buildIds } } });
      await tx.buildJob.deleteMany({ where: { id: { in: buildIds } } });
      await tx.agentStep.deleteMany({ where: { run: { publisherId: { in: publisherIds } } } });
      await tx.agentRun.deleteMany({ where: { publisherId: { in: publisherIds } } });
      // Licenses held by the demo publisher (nothing references them any more).
      await tx.licenseGrant.deleteMany({ where: { licenseeId: { in: publisherIds } } });
      // Platform API state: its event log (and pending deliveries), webhook endpoints and idempotency records.
      await tx.outboundEvent.deleteMany({ where: { ownerId: { in: publisherIds } } });
      await tx.webhookEndpoint.deleteMany({ where: { ownerId: { in: publisherIds } } });
      await tx.idempotencyKey.deleteMany({ where: { userId: { in: publisherIds } } });
      // Reconciliation issues about the sales and payouts just removed.
      await tx.reconciliationIssue.deleteMany({ where: { ownerId: { in: publisherIds } } });
      // Keys minted by anonymous demo visitors stop working on reset.
      await tx.apiKey.updateMany({ where: { userId: { in: publisherIds }, revokedAt: null }, data: { revokedAt: new Date() } });

      // 2. Restore the demo personas and fixtures idempotently.
      for (const u of DEMO_USERS) {
        const paypalEmail =
          u.role === 'contributor' ? (u.payeeSlot !== undefined ? payees[u.payeeSlot] : undefined) ?? `${u.id.replace('user_', '')}@tracepay-demo.example` : null;
        await tx.user.upsert({
          where: { id: u.id },
          update: { name: u.name, role: u.role, paypalEmail, passwordHash: null },
          create: { id: u.id, email: u.email, name: u.name, role: u.role, paypalEmail },
        });
      }
      for (const [i, a] of DEMO_ASSETS.entries()) {
        const content = contents[i]!;
        const versionId = `${a.id}_v1`;
        await tx.asset.upsert({
          where: { id: a.id },
          update: { title: a.title, kind: a.kind, description: a.description, archivedAt: null },
          create: { id: a.id, ownerId: a.ownerId, title: a.title, kind: a.kind, description: a.description },
        });
        // Versions are immutable: create only if missing.
        const exists = await tx.assetVersion.findUnique({ where: { id: versionId }, select: { id: true } });
        if (!exists) {
          await tx.assetVersion.create({ data: { id: versionId, assetId: a.id, version: 1, sha256: sha256Hex(content), content } });
          const paragraphs = chunkContent(content).slice(1);
          await tx.sourceChunk.createMany({
            data: paragraphs.map((text, n) => ({ id: `${versionId}_c${n + 1}`, assetVersionId: versionId, ordinal: n + 1, text })),
          });
        }
        await tx.licenseGrant.create({
          data: {
            id: a.licenseId,
            assetId: a.id,
            licenseeId: DEMO_IDS.publisher,
            version: 1,
            status: 'approved',
            terms: a.terms as unknown as Prisma.InputJsonValue,
            termsHash: sha256Hex(canonicalJson(a.terms)),
            origin: 'manual',
            sourceText: a.licenseText,
            offeredAt: new Date('2026-09-28T00:00:00Z'),
            approvedAt: new Date('2026-10-01T00:00:00Z'),
            approvedById: DEMO_IDS.publisher,
          },
        });
      }

      await appendAudit(tx, {
        entityType: 'system',
        entityId: 'demo',
        eventType: 'demo.reset',
        payload: { removedBuilds: buildIds.length, removedSales: saleIds.length },
        tenantId: null,
      });
      return { removedBuilds: buildIds.length, removedSales: saleIds.length };
    },
    { timeout: 30_000 },
  );
}
