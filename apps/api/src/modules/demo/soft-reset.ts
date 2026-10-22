import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Prisma } from '../../generated/prisma/client';
import type { Db } from '../../db';
import { appendAudit, lockAuditChain } from '../audit/audit-log';
import { canonicalJson, sha256Hex } from '../audit/hash-chain';
import { chunkContent, DEMO_ASSETS, DEMO_IDS, DEMO_USERS } from './world';

const FIXTURE_DIR = process.env.DEMO_FIXTURE_DIR ?? path.resolve(process.cwd(), 'fixtures/demo-assets');
const payeeEmails = () =>
  (process.env.DEMO_PAYEE_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);

/** Starting answer credit for the demo buyer, labeled as such in their ledger. */
export const DEMO_CREDIT_CENTS = 200;

export const DEMO_EMAILS = new Set(DEMO_USERS.map((u) => u.email.toLowerCase()));

/**
 * The in-app "Reset demo". Unlike the developer seed (which truncates every
 * table), this only touches the demo publisher's own work and restores the demo
 * fixtures. Real accounts — and everything they built, bought or licensed —
 * are never deleted. The audit chain is never rewritten either.
 */
export async function softResetDemo(db: Db): Promise<{ removedBuilds: number; removedSales: number }> {
  // Background work (PayPal webhooks, reconciliation, the agent, other demo visitors)
  // can touch the demo's rows mid-reset. Locks below keep that orderly; a collision
  // that still slips through (a deadlock, a row added under us) just runs it again.
  for (let attempt = 1; ; attempt++) {
    try {
      return await resetOnce(db);
    } catch (err) {
      if (attempt >= 3 || !collided(err)) throw err;
    }
  }
}

const collided = (err: unknown) => {
  const code = (err as { code?: string }).code;
  return code === 'P2003' || code === 'P2034' || /40P01|deadlock/i.test((err as Error).message ?? '');
};

async function resetOnce(db: Db): Promise<{ removedBuilds: number; removedSales: number }> {
  const publisherIds = DEMO_USERS.filter((u) => u.role === 'publisher').map((u) => u.id);
  const payees = payeeEmails();
  const contents = await Promise.all(DEMO_ASSETS.map((a) => readFile(path.join(FIXTURE_DIR, a.file), 'utf8')));

  return db.$transaction(
    async (tx) => {
      // The audit chain first, like every money path (audit chain → accounts/sales → the rest).
      await lockAuditChain(tx);
      // 0. Lock first, in the order the money paths use (sale rows, then the rest): an
      // in-flight capture finishes before we delete, and no new sale, settlement or
      // agent step can attach to rows we are removing.
      const mine = Prisma.join(publisherIds);
      await tx.$queryRaw`SELECT s.id FROM "Sale" s JOIN "Artifact" a ON a.id = s."artifactId" JOIN "BuildJob" b ON b.id = a."buildJobId" WHERE b."publisherId" IN (${mine}) FOR UPDATE OF s`;
      await tx.$queryRaw`SELECT a.id FROM "Artifact" a JOIN "BuildJob" b ON b.id = a."buildJobId" WHERE b."publisherId" IN (${mine}) FOR UPDATE OF a`;
      await tx.$queryRaw`SELECT s.id FROM "Sale" s JOIN "Artifact" a ON a.id = s."artifactId" JOIN "BuildJob" b ON b.id = a."buildJobId" WHERE b."publisherId" IN (${mine}) FOR UPDATE OF s`;
      await tx.$queryRaw`SELECT id FROM "AgentRun" WHERE "publisherId" IN (${mine}) FOR UPDATE`;

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
      // The demo buyer's Shopping Assistant runs.
      const buyerIds = DEMO_USERS.filter((u) => u.role === 'buyer').map((u) => u.id);
      await tx.agentStep.deleteMany({ where: { run: { publisherId: { in: buyerIds } } } });
      await tx.agentRun.deleteMany({ where: { publisherId: { in: buyerIds } } });
      await tx.apiKey.updateMany({ where: { userId: { in: buyerIds }, revokedAt: null }, data: { revokedAt: new Date() } });
      // Pay-per-citation: the demo buyer's own answers and credits. Answers real accounts asked of the
      // demo library stay (with their credits and the payouts that paid them): real money, real records.
      await tx.citationCredit.deleteMany({ where: { answer: { account: { ownerId: { in: buyerIds } } } } });
      await tx.royaltyPayoutItem.deleteMany({ where: { payout: { libraryId: { in: publisherIds } }, credits: { none: {} } } });
      await tx.royaltyPayout.deleteMany({ where: { libraryId: { in: publisherIds }, items: { none: {} } } });
      await tx.answer.deleteMany({ where: { account: { ownerId: { in: buyerIds } } } });
      await tx.creditEntry.deleteMany({ where: { account: { ownerId: { in: buyerIds } } } });
      await tx.creditTopUp.deleteMany({ where: { account: { ownerId: { in: buyerIds } } } });
      await tx.creditAccount.deleteMany({ where: { ownerId: { in: buyerIds } } });
      await tx.idempotencyKey.deleteMany({ where: { userId: { in: buyerIds } } });
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

      // Visitors can ask right away; topping up with PayPal works the same as for anyone.
      for (const buyerId of buyerIds) {
        const account = await tx.creditAccount.create({ data: { ownerId: buyerId, balanceCents: DEMO_CREDIT_CENTS } });
        await tx.creditEntry.create({ data: { accountId: account.id, kind: 'demo_credit', amountCents: DEMO_CREDIT_CENTS } });
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
