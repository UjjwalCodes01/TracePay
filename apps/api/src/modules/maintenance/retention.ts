import type { Db } from '../../db';

/**
 * Personal data is kept only as long as it is useful:
 *  - expired sign-in sessions (with their browser user agent) are deleted after a day;
 *  - PayPal webhook payloads (they carry buyer names and emails) are emptied after
 *    90 days — the event id stays, so a late redelivery is still recognised as a duplicate.
 * Financial records (sales, settlements, payouts, the audit log) are kept: accounting
 * requires them, and the audit log only holds ids.
 */
export const WEBHOOK_PAYLOAD_RETENTION_DAYS = 90;

export async function pruneRetention(db: Db, now = new Date()): Promise<{ sessions: number; webhookPayloads: number }> {
  const sessions = await db.session.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 24 * 3_600_000) } } });
  const webhookPayloads = await db.$executeRaw`
    UPDATE "WebhookEvent" SET payload = '{"redacted":true}'::jsonb
    WHERE "receivedAt" < ${new Date(now.getTime() - WEBHOOK_PAYLOAD_RETENTION_DAYS * 24 * 3_600_000)}
      AND "processedAt" IS NOT NULL
      AND payload <> '{"redacted":true}'::jsonb`;
  return { sessions: sessions.count, webhookPayloads };
}
