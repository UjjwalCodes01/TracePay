import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Prisma } from '../../generated/prisma/client';
import type { Db } from '../../db';
import { canonicalJson, sha256Hex } from '../audit/hash-chain';
import { appendAudit } from '../audit/audit-log';
import { chunkContent, DEMO_ASSETS, DEMO_IDS, DEMO_USERS } from './world';

const FIXTURE_DIR = process.env.DEMO_FIXTURE_DIR ?? path.resolve(process.cwd(), 'fixtures/demo-assets');

/** Sandbox personal accounts that receive demo payouts, in payeeSlot order. */
function payeeEmails(): string[] {
  return (process.env.DEMO_PAYEE_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
}

/** Every table, children first, so TRUNCATE order never matters with CASCADE anyway. */
const TABLES = [
  'AuditEvent', 'PayoutItem', 'PayoutBatch', 'SettlementLine', 'SettlementRun', 'WebhookEvent',
  'PayPalPayment', 'Sale', 'ArtifactCitation', 'Artifact', 'SourceEvent', 'BuildSource', 'BuildJob',
  'AgentStep', 'AgentRun', 'LicenseGrant', 'SourceChunk', 'AssetVersion', 'Asset', 'ApiKey', 'Session', 'User',
  'WebhookDelivery', 'OutboundEvent', 'WebhookEndpoint', 'IdempotencyKey', 'ReconciliationIssue',
  'CitationCredit', 'RoyaltyPayoutItem', 'RoyaltyPayout', 'Answer', 'CreditEntry', 'CreditTopUp', 'CreditAccount', 'DemoWorld', 'SpendingMandate',
];

/**
 * Restores TracePay's own fixtures. It does not (and cannot) reverse PayPal
 * sandbox transactions; every new checkout after a reset creates a fresh order.
 */
export async function resetAndSeed(db: Db): Promise<{ users: number; assets: number; chunks: number }> {
  const payees = payeeEmails();
  const contents = await Promise.all(DEMO_ASSETS.map((a) => readFile(path.join(FIXTURE_DIR, a.file), 'utf8')));

  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);

    for (const u of DEMO_USERS) {
      const fallback = `${u.id.replace('user_', '')}@tracepay-demo.example`;
      await tx.user.create({
        data: {
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role,
          paypalEmail: u.role === 'contributor' ? (u.payeeSlot !== undefined ? payees[u.payeeSlot] ?? fallback : fallback) : null,
        },
      });
    }

    let chunks = 0;
    for (const [i, a] of DEMO_ASSETS.entries()) {
      const content = contents[i]!;
      const versionId = `${a.id}_v1`;
      await tx.asset.create({
        data: { id: a.id, ownerId: a.ownerId, title: a.title, kind: a.kind, description: a.description },
      });
      await tx.assetVersion.create({
        data: { id: versionId, assetId: a.id, version: 1, sha256: sha256Hex(content), content },
      });
      // The first paragraph of each demo file is a "synthetic data" header, not citable content.
      const paragraphs = chunkContent(content).slice(1);
      await tx.sourceChunk.createMany({
        data: paragraphs.map((text, i) => ({ id: `${versionId}_c${i + 1}`, assetVersionId: versionId, ordinal: i + 1, text })),
      });
      chunks += paragraphs.length;

      // A work without a reuse license gets no grant: it is registered, never used.
      if (a.licenseId) await tx.licenseGrant.create({
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
          // Both parties agreed: the contributor offered, the publisher accepted.
          offeredAt: new Date('2026-09-28T00:00:00Z'),
          approvedAt: new Date('2026-10-01T00:00:00Z'),
          approvedById: DEMO_IDS.publisher,
        },
      });
    }

    await appendAudit(tx, {
      entityType: 'system',
      entityId: 'demo',
      eventType: 'demo.seeded',
      payload: { users: DEMO_USERS.length, assets: DEMO_ASSETS.length, chunks, payeesConfigured: payees.length },
    });

    return { users: DEMO_USERS.length, assets: DEMO_ASSETS.length, chunks };
  });
}
