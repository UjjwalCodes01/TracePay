import type { Prisma } from '../../generated/prisma/client';
import type { Tx } from '../../db';
import { appendAudit } from '../audit/audit-log';

/**
 * "Needs attention": money situations a person must look at. Each kind has a
 * plain-language title and what to do about it. An issue is opened at most once
 * per (kind, subject) while open, and resolved automatically when its cause
 * clears (or by the publisher, with a note).
 */
export const ISSUE_KINDS = {
  sale_refunded: {
    title: 'A sale was refunded',
    detail: 'PayPal refunded this sale. Its settlement is on hold; any royalties already paid out are settled under your license agreements.',
  },
  sale_partially_refunded: {
    title: 'A sale was partly refunded',
    detail: 'PayPal refunded part of this sale. Its settlement is on hold until you decide how to settle the remainder.',
  },
  sale_reversed: {
    title: 'A payment was reversed',
    detail: 'PayPal reversed this payment (for example a chargeback). Its settlement is on hold.',
  },
  capture_mismatch: {
    title: 'A payment didn’t match the sale',
    detail: 'PayPal captured a different amount, currency or status than the sale expected. Check it in PayPal before settling.',
  },
  capture_declined: {
    title: 'A pending payment was declined',
    detail: 'PayPal declined a payment that had been pending. The buyer wasn’t charged and the sale didn’t go through.',
  },
  payout_failed: {
    title: 'Some royalties couldn’t be paid',
    detail: 'PayPal couldn’t deliver one or more payouts (failed, returned or blocked). Check the contributors’ PayPal emails, then use “Retry failed payouts”.',
  },
  payout_unclaimed: {
    title: 'Royalties are waiting to be claimed',
    detail: 'A contributor hasn’t claimed their payout yet (usually: no PayPal account for that email). PayPal returns it after 30 days if unclaimed.',
  },
  payout_batch_denied: {
    title: 'PayPal refused a payout batch',
    detail: 'PayPal denied this batch of payouts. Nothing was paid. Check your PayPal account, then retry.',
  },
  payout_unconfirmed: {
    title: 'PayPal hasn’t confirmed a payout batch',
    detail: 'PayPal already received this batch (an earlier response was lost) but hasn’t confirmed it yet. Nothing was paid twice. If this lasts, check the batch in your PayPal dashboard.',
  },
  capture_after_close: {
    title: 'PayPal took a payment for a closed checkout',
    detail: 'PayPal captured money for a sale TracePay had already closed (for example a checkout that had looked expired). Check it in PayPal and refund the buyer or honour the sale.',
  },
  payout_submit_failed: {
    title: 'Royalties weren’t sent',
    detail: 'PayPal didn’t accept a batch of payouts, so nothing was paid. Use “Send payouts” or “Retry failed payouts” again from the settlement.',
  },
  check_stuck: {
    title: 'TracePay can’t confirm something with PayPal',
    detail: 'Repeated checks with PayPal didn’t reach a final answer. Look it up in your PayPal dashboard.',
  },
  payout_stuck: {
    title: 'A payout batch hasn’t finished',
    detail: 'PayPal still reports unfinished payouts in this batch after 45 days. Check it in your PayPal dashboard.',
  },
} as const;

export type IssueKind = keyof typeof ISSUE_KINDS;
export type IssueSubject = 'sale' | 'settlement' | 'payout_batch';

/**
 * Opens an issue unless the same one is already open. Serialised per subject,
 * so concurrent detections (webhook + reconciliation) open it once.
 */
export async function openIssue(
  tx: Tx,
  input: { ownerId: string; kind: IssueKind; subjectType: IssueSubject; subjectId: string; data?: Record<string, unknown>; artifactId?: string | null },
): Promise<{ id: string; created: boolean }> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`issue:${input.kind}:${input.subjectId}`}))`;
  const latest = await tx.reconciliationIssue.findFirst({
    where: { kind: input.kind, subjectId: input.subjectId },
    orderBy: { openedAt: 'desc' },
    select: { id: true, status: true, resolvedBy: true, data: true },
  });
  if (latest?.status === 'open') return { id: latest.id, created: false };
  // A person already handled exactly this: don't reopen it on every check while the
  // situation is unchanged. A change (e.g. more payouts affected) reopens it.
  if (latest && latest.resolvedBy !== 'auto' && JSON.stringify(latest.data ?? {}) === JSON.stringify(input.data ?? {})) {
    return { id: latest.id, created: false };
  }
  const spec = ISSUE_KINDS[input.kind];
  const issue = await tx.reconciliationIssue.create({
    data: {
      ownerId: input.ownerId,
      kind: input.kind,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      title: spec.title,
      detail: spec.detail,
      data: (input.data ?? {}) as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  await appendAudit(tx, {
    entityType: 'reconciliation_issue',
    entityId: issue.id,
    artifactId: input.artifactId ?? null,
    tenantId: input.ownerId,
    eventType: 'reconciliation.issue_opened',
    payload: { kind: input.kind, subjectType: input.subjectType, subjectId: input.subjectId, title: spec.title },
  });
  return { id: issue.id, created: true };
}

/** Resolves open issues of these kinds for a subject (automatically, or by a person). */
export async function resolveIssues(
  tx: Tx,
  input: { subjectId: string; kinds: IssueKind[]; resolvedBy: 'auto' | string; resolution: string },
): Promise<number> {
  const open = await tx.reconciliationIssue.findMany({
    where: { subjectId: input.subjectId, kind: { in: input.kinds }, status: 'open' },
    select: { id: true, ownerId: true, kind: true },
  });
  for (const issue of open) {
    const updated = await tx.reconciliationIssue.updateMany({
      where: { id: issue.id, status: 'open' },
      data: { status: 'resolved', resolvedAt: new Date(), resolvedBy: input.resolvedBy, resolution: input.resolution },
    });
    if (updated.count === 0) continue;
    await appendAudit(tx, {
      entityType: 'reconciliation_issue',
      entityId: issue.id,
      tenantId: issue.ownerId,
      eventType: 'reconciliation.issue_resolved',
      payload: { kind: issue.kind, resolvedBy: input.resolvedBy === 'auto' ? 'auto' : 'user', resolution: input.resolution },
    });
  }
  return open.length;
}

/** The publisher who owns a sale (and so must act on its issues). */
export async function saleOwner(tx: Tx, saleId: string): Promise<{ ownerId: string; artifactId: string } | null> {
  const sale = await tx.sale.findUnique({ where: { id: saleId }, select: { artifactId: true, artifact: { select: { buildJob: { select: { publisherId: true } } } } } });
  return sale ? { ownerId: sale.artifact.buildJob.publisherId, artifactId: sale.artifactId } : null;
}

/** A person resolves an open issue (with a note on what they did). */
export async function resolveIssueById(tx: Tx, input: { ownerId: string; issueId: string; userId: string; resolution: string }) {
  const issue = await tx.reconciliationIssue.findFirst({ where: { id: input.issueId, ownerId: input.ownerId }, select: { id: true, status: true, subjectId: true, kind: true } });
  if (!issue) return null;
  if (issue.status === 'open') {
    await resolveIssues(tx, { subjectId: issue.subjectId, kinds: [issue.kind as IssueKind], resolvedBy: input.userId, resolution: input.resolution });
  }
  return tx.reconciliationIssue.findUniqueOrThrow({ where: { id: issue.id } });
}
