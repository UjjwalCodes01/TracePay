import { formatMoney } from '@tracepay/shared';
import type { Db } from '../../db';
import { PayPalApiError } from '../../integrations/paypal/client';
import type { PayPalGateway } from '../../integrations/paypal/gateway';
import { appendAudit, lockAuditChain } from '../audit/audit-log';
import { applyCapture, captureSale, PaymentError, startCheckout, type CaptureOutcome } from '../payments/payments.service';

/**
 * Spending mandates: a buyer saves PayPal once (in PayPal's vault) and sets limits — most per purchase,
 * most in total, an end date — and their shopping assistant may then pay on its own within them. The
 * limits are enforced here, in code, before every charge; the model never sees the vault id and can't
 * raise a limit. Revoking deletes the saved wallet at PayPal.
 */

export class MandateError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'state' | 'limit' | 'provider',
  ) {
    super(message);
    this.name = 'MandateError';
  }
}

export const MANDATE_MAX_TOTAL_CENTS = 50_000;
export const MANDATE_MAX_DAYS = 90;

export interface MandateView {
  id: string;
  status: 'pending' | 'active' | 'revoked';
  maxPerPurchaseCents: number;
  maxTotalCents: number;
  spentCents: number;
  remainingCents: number;
  expiresAt: Date;
  payerEmail: string | null;
  expired: boolean;
}

type MandateRow = { id: string; status: 'pending' | 'active' | 'revoked'; maxPerPurchaseCents: number; maxTotalCents: number; spentCents: number; expiresAt: Date; payerEmail: string | null };

export const mandateView = (m: MandateRow): MandateView => ({
  id: m.id,
  status: m.status,
  maxPerPurchaseCents: m.maxPerPurchaseCents,
  maxTotalCents: m.maxTotalCents,
  spentCents: m.spentCents,
  remainingCents: Math.max(0, m.maxTotalCents - m.spentCents),
  expiresAt: m.expiresAt,
  payerEmail: m.payerEmail,
  expired: m.expiresAt.getTime() <= Date.now(),
});

const vaultMessage = (err: unknown) =>
  err instanceof PayPalApiError && err.status === 403
    ? 'Saving PayPal for your assistant isn’t enabled for this PayPal app yet (PayPal’s Vault feature).'
    : 'PayPal couldn’t save your payment method right now. Please try again.';

/** The buyer's current mandate (active, else the one waiting for approval at PayPal). */
export async function currentMandate(db: Db, buyerId: string): Promise<MandateView | null> {
  const m = await db.spendingMandate.findFirst({ where: { buyerId, status: { in: ['active', 'pending'] } }, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }] });
  return m ? mandateView(m) : null;
}

/** Starts a mandate: the buyer then approves saving their PayPal at the returned link. */
export async function startMandate(
  db: Db,
  paypal: PayPalGateway,
  args: { buyerId: string; maxPerPurchaseCents: number; maxTotalCents: number; days: number; appBaseUrl: string },
): Promise<{ mandateId: string; approveUrl: string }> {
  if (args.maxPerPurchaseCents <= 0 || args.maxTotalCents < args.maxPerPurchaseCents || args.maxTotalCents > MANDATE_MAX_TOTAL_CENTS) {
    throw new MandateError(`Limits must be positive, the total at least the per-purchase limit, and at most ${formatMoney(MANDATE_MAX_TOTAL_CENTS)}.`, 'limit');
  }
  if (args.days < 1 || args.days > MANDATE_MAX_DAYS) throw new MandateError(`A mandate lasts 1–${MANDATE_MAX_DAYS} days.`, 'limit');
  // Unfinished ones are abandoned: only the latest approval counts.
  await db.spendingMandate.updateMany({ where: { buyerId: args.buyerId, status: 'pending' }, data: { status: 'revoked', revokedAt: new Date() } });
  const m = await db.spendingMandate.create({
    data: { buyerId: args.buyerId, maxPerPurchaseCents: args.maxPerPurchaseCents, maxTotalCents: args.maxTotalCents, expiresAt: new Date(Date.now() + args.days * 86_400_000) },
  });
  let token;
  try {
    token = await paypal.createSetupToken(
      {
        payment_source: {
          paypal: {
            description: `TracePay shopping assistant: up to ${formatMoney(args.maxPerPurchaseCents)} a purchase, ${formatMoney(args.maxTotalCents)} in all, for ${args.days} days.`,
            usage_pattern: 'UNSCHEDULED_POSTPAID',
            usage_type: 'MERCHANT',
            customer_type: 'CONSUMER',
            permit_multiple_payment_tokens: true,
            experience_context: {
              brand_name: 'TracePay',
              locale: 'en-US',
              shipping_preference: 'NO_SHIPPING',
              payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
              return_url: `${args.appBaseUrl}/assistant?mandate=${m.id}`,
              cancel_url: `${args.appBaseUrl}/assistant?mandate=${m.id}&cancelled=1`,
            },
          },
        },
      },
      `mandate-setup-${m.id}`,
    );
  } catch (err) {
    await db.spendingMandate.update({ where: { id: m.id }, data: { status: 'revoked', revokedAt: new Date() } });
    throw new MandateError(vaultMessage(err), 'provider');
  }
  const approveUrl = token.links.find((l) => l.rel === 'approve' || l.rel === 'payer-action')?.href;
  if (!approveUrl) throw new MandateError('PayPal didn’t return an approval link.', 'provider');
  await db.spendingMandate.update({ where: { id: m.id }, data: { setupTokenId: token.id, paypalCustomerId: token.customer?.id ?? null } });
  return { mandateId: m.id, approveUrl };
}

/** After the buyer approved at PayPal: saves the wallet and switches the mandate on. */
export async function activateMandate(db: Db, paypal: PayPalGateway, mandateId: string, buyerId: string): Promise<MandateView> {
  const m = await db.spendingMandate.findFirst({ where: { id: mandateId, buyerId } });
  if (!m) throw new MandateError('Mandate not found.', 'not_found');
  if (m.status === 'active') return mandateView(m);
  if (m.status !== 'pending' || !m.setupTokenId) throw new MandateError('This mandate was cancelled. Start a new one.', 'state');
  let token;
  try {
    token = await paypal.createPaymentToken(m.setupTokenId, `mandate-token-${m.id}`);
  } catch (err) {
    if (err instanceof PayPalApiError && err.status === 422) throw new MandateError('PayPal hasn’t approved saving your payment method yet. Finish the approval at PayPal, then try again.', 'state');
    throw new MandateError(vaultMessage(err), 'provider');
  }
  // One active mandate at a time: the previous one ends (and its saved wallet is removed below).
  const previous = await db.spendingMandate.findMany({ where: { buyerId, status: 'active' } });
  const active = await db.$transaction(async (tx) => {
    await lockAuditChain(tx); // the chain first, as on every path that appends
    await tx.spendingMandate.updateMany({ where: { buyerId, status: 'active' }, data: { status: 'revoked', revokedAt: new Date() } });
    const updated = await tx.spendingMandate.update({
      where: { id: m.id },
      data: { status: 'active', vaultId: token.id, paypalCustomerId: token.customer?.id ?? m.paypalCustomerId, payerEmail: token.payment_source?.paypal?.email_address ?? null, activatedAt: new Date() },
    });
    await appendAudit(tx, { entityType: 'mandate', entityId: m.id, eventType: 'mandate.activated', payload: { buyerId, maxPerPurchaseCents: m.maxPerPurchaseCents, maxTotalCents: m.maxTotalCents, expiresAt: m.expiresAt.toISOString() } });
    return updated;
  });
  for (const p of previous) if (p.vaultId) await paypal.deletePaymentToken(p.vaultId).catch(() => undefined);
  return mandateView(active);
}

/** Ends the mandate and removes the saved wallet from PayPal's vault. */
export async function revokeMandate(db: Db, paypal: PayPalGateway, buyerId: string): Promise<void> {
  const open = await db.spendingMandate.findMany({ where: { buyerId, status: { in: ['active', 'pending'] } } });
  if (!open.length) return;
  await db.$transaction(async (tx) => {
    await lockAuditChain(tx);
    await tx.spendingMandate.updateMany({ where: { id: { in: open.map((m) => m.id) } }, data: { status: 'revoked', revokedAt: new Date() } });
    for (const m of open) await appendAudit(tx, { entityType: 'mandate', entityId: m.id, eventType: 'mandate.revoked', payload: { buyerId } });
  });
  // Best effort: the mandate is already off in TracePay, so nothing can be charged even if PayPal is down.
  for (const m of open) if (m.vaultId) await paypal.deletePaymentToken(m.vaultId).catch(() => undefined);
}

/** Why the mandate can't pay `priceCents` right now, or null if it can. */
export function mandateRefusal(m: MandateView | null, priceCents: number): string | null {
  if (!m || m.status !== 'active') return 'You haven’t let your assistant pay on its own.';
  if (m.expired) return 'Your assistant’s permission to pay has ended.';
  if (priceCents > m.maxPerPurchaseCents) return `It costs more than your ${formatMoney(m.maxPerPurchaseCents)} limit per purchase.`;
  if (priceCents > m.remainingCents) return `Only ${formatMoney(m.remainingCents)} is left of what your assistant may spend.`;
  return null;
}

/**
 * Pays for a report with the buyer's saved PayPal, within their mandate. The amount is reserved under
 * a row lock before PayPal is called (so concurrent purchases can't overspend), released if PayPal
 * definitely didn't charge, and kept if the outcome is unknown. The capture is verified like any sale.
 */
export async function payWithMandate(
  db: Db,
  paypal: PayPalGateway,
  args: { buyerId: string; artifactId: string; appBaseUrl: string; allowRepeat?: boolean },
): Promise<CaptureOutcome & { mandateId: string; remainingCents: number }> {
  const artifact = await db.artifact.findUnique({ where: { id: args.artifactId }, select: { priceCents: true } });
  if (!artifact) throw new MandateError('Report not found.', 'not_found');
  const price = artifact.priceCents;

  const reserved = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "SpendingMandate" WHERE "buyerId" = ${args.buyerId} AND status = 'active' FOR UPDATE`;
    const m = rows[0] ? await tx.spendingMandate.findUniqueOrThrow({ where: { id: rows[0].id } }) : null;
    const refusal = mandateRefusal(m ? mandateView(m) : null, price);
    if (refusal || !m?.vaultId) throw new MandateError(refusal ?? 'No saved PayPal for this mandate.', 'limit');
    await tx.spendingMandate.update({ where: { id: m.id }, data: { spentCents: { increment: price } } });
    return { id: m.id, vaultId: m.vaultId };
  });
  const release = () => db.spendingMandate.update({ where: { id: reserved.id }, data: { spentCents: { decrement: price } } }).catch(() => undefined);

  let outcome: CaptureOutcome;
  try {
    const started = await startCheckout(db, paypal, { artifactId: args.artifactId, buyerId: args.buyerId, appBaseUrl: args.appBaseUrl, allowRepeat: args.allowRepeat, vault: { vaultId: reserved.vaultId, mandateId: reserved.id } });
    const capture = started.order?.purchase_units?.[0]?.payments?.captures?.[0];
    outcome =
      started.order?.status === 'COMPLETED' && capture
        ? await applyCapture(db, started.saleId, started.order, capture, 'api')
        : await captureSale(db, paypal, started.saleId); // approved but not yet captured
  } catch (err) {
    if (!(err instanceof PaymentError && err.code === 'unconfirmed')) await release();
    throw err;
  }
  // Money PayPal didn't take (declined, failed verification) doesn't count against the mandate.
  if (outcome.saleStatus === 'payment_failed') await release();
  const m = await db.spendingMandate.findUniqueOrThrow({ where: { id: reserved.id } });
  return { ...outcome, mandateId: m.id, remainingCents: Math.max(0, m.maxTotalCents - m.spentCents) };
}
