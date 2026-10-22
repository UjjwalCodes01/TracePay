import type { Db } from '../../db';
import { appendAudit, lockAuditChain } from '../audit/audit-log';
import { withdrawArtifact } from '../sales/rights.service';

/**
 * A person's own data: export it, or delete the account.
 *
 * Deleting anonymises rather than erases rows that other people's money depends on:
 * sales, settlements, payouts and the audit log are financial records (and the audit
 * log is a hash chain that only ever holds ids). Everything that identifies the person
 * — name, email, PayPal address, password, sessions, keys, the questions they asked —
 * is removed.
 */

export class AccountError extends Error {
  constructor(
    message: string,
    readonly code: 'state' | 'not_found',
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

const TAKE = 5000;

export async function exportAccount(db: Db, userId: string) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, role: true, paypalEmail: true, createdAt: true } });
  if (!user) throw new AccountError('Account not found.', 'not_found');
  const account = await db.creditAccount.findUnique({ where: { ownerId: userId } });
  const [apiKeys, purchases, assets, licensesHeld, licensesGranted, earnings, answerCredits, answers, creditEntries, topUps] = await Promise.all([
    db.apiKey.findMany({ where: { userId }, select: { name: true, prefix: true, access: true, createdAt: true, lastUsedAt: true, expiresAt: true, revokedAt: true }, take: TAKE }),
    db.sale.findMany({ where: { buyerId: userId }, select: { id: true, status: true, amountCents: true, currency: true, createdAt: true, artifact: { select: { title: true } } }, take: TAKE }),
    db.asset.findMany({ where: { ownerId: userId }, select: { id: true, title: true, kind: true, description: true, createdAt: true, archivedAt: true, versions: { select: { version: true, sha256: true, createdAt: true } } }, take: TAKE }),
    db.licenseGrant.findMany({ where: { licenseeId: userId }, select: { id: true, version: true, status: true, terms: true, asset: { select: { title: true } } }, take: TAKE }),
    db.licenseGrant.findMany({ where: { asset: { ownerId: userId } }, select: { id: true, version: true, status: true, terms: true, asset: { select: { title: true } }, licensee: { select: { name: true } } }, take: TAKE }),
    db.settlementLine.findMany({ where: { recipientId: userId }, select: { amountCents: true, formula: true, payable: true, run: { select: { status: true, createdAt: true } }, payoutItem: { select: { status: true, transactionId: true } } }, take: TAKE }),
    db.citationCredit.findMany({ where: { contributorId: userId }, select: { assetTitle: true, citations: true, centsPerCitation: true, amountCents: true, status: true, createdAt: true }, take: TAKE }),
    account ? db.answer.findMany({ where: { accountId: account.id }, select: { id: true, question: true, status: true, chargedCents: true, createdAt: true, library: { select: { name: true } } }, take: TAKE }) : [],
    account ? db.creditEntry.findMany({ where: { accountId: account.id }, select: { kind: true, amountCents: true, createdAt: true }, take: TAKE }) : [],
    account ? db.creditTopUp.findMany({ where: { accountId: account.id }, select: { id: true, amountCents: true, status: true, createdAt: true }, take: TAKE }) : [],
  ]);
  return {
    exportedAt: new Date().toISOString(),
    profile: user,
    apiKeys,
    purchases,
    sources: assets,
    licenses: { held: licensesHeld, granted: licensesGranted },
    reportEarnings: earnings,
    answerEarnings: answerCredits,
    answerCredit: account ? { balanceCents: account.balanceCents, entries: creditEntries, topUps } : null,
    questionsAsked: answers,
  };
}

/** What would be lost by deleting now; deletion is refused while either is non-zero. */
async function moneyStillOwed(db: Db, userId: string) {
  const account = await db.creditAccount.findUnique({ where: { ownerId: userId } });
  const [answerOwed, linesOwed] = await Promise.all([
    db.citationCredit.aggregate({ where: { contributorId: userId, status: { in: ['accrued', 'in_payout'] } }, _sum: { amountCents: true } }),
    db.settlementLine.aggregate({
      where: { recipientId: userId, payable: true, kind: 'contributor', run: { status: { in: ['calculated', 'approved', 'payout_submitted'] } }, OR: [{ payoutItem: null }, { payoutItem: { status: { not: 'SUCCESS' } } }] },
      _sum: { amountCents: true },
    }),
  ]);
  return {
    creditCents: account ? Math.max(0, account.balanceCents) + account.reservedCents : 0,
    owedToYouCents: (answerOwed._sum.amountCents ?? 0) + (linesOwed._sum.amountCents ?? 0),
  };
}

export async function deleteAccount(db: Db, userId: string) {
  const owed = await moneyStillOwed(db, userId);
  if (owed.creditCents > 0) throw new AccountError(`You still have answer credit (${(owed.creditCents / 100).toFixed(2)} USD). Use it, or ask for a refund, before deleting your account.`, 'state');
  if (owed.owedToYouCents > 0) throw new AccountError(`You are still owed ${(owed.owedToYouCents / 100).toFixed(2)} USD in royalties. Deleting now would forfeit it; wait until it has been paid.`, 'state');

  await db.$transaction(async (tx) => {
    await lockAuditChain(tx);
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
    if (!user) throw new AccountError('Account not found.', 'not_found');
    // Reports a publisher sells come off sale; a contributor's sources come off the marketplace.
    if (user.role === 'publisher') {
      const listed = await tx.artifact.findMany({ where: { status: 'listed', buildJob: { publisherId: userId } }, select: { id: true } });
      for (const a of listed) await withdrawArtifact(tx, a.id, ['The publisher closed their account.'], 'system');
    }
    await tx.asset.updateMany({ where: { ownerId: userId, archivedAt: null }, data: { archivedAt: new Date() } });
    await tx.webhookEndpoint.deleteMany({ where: { ownerId: userId } });
    await tx.apiKey.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.session.deleteMany({ where: { userId } });
    await tx.idempotencyKey.deleteMany({ where: { userId } });
    // Personal text: the questions they asked, and the PayPal email PayPal reported for their purchases.
    const account = await tx.creditAccount.findUnique({ where: { ownerId: userId } });
    if (account) await tx.answer.updateMany({ where: { accountId: account.id }, data: { question: '[deleted]' } });
    await tx.payPalPayment.updateMany({ where: { sale: { buyerId: userId } }, data: { payerEmail: null } });
    await tx.user.update({
      where: { id: userId },
      data: { email: `deleted-${userId}@deleted.tracepay.invalid`, name: 'Deleted account', paypalEmail: null, passwordHash: null },
    });
    await appendAudit(tx, { entityType: 'user', entityId: userId, eventType: 'account.deleted', payload: { role: user.role } });
  });
}
