import { describe, expect, it } from 'vitest';
import { countsAsSale } from '../src/modules/provenance/provenance.service';

describe('countsAsSale (receipts and provenance)', () => {
  const paid = { captureId: 'CAP-1' };
  it('includes paid sales, and paid sales later refunded or reversed', () => {
    expect(countsAsSale({ status: 'captured', payment: paid })).toBe(true);
    expect(countsAsSale({ status: 'refunded', payment: paid })).toBe(true);
    expect(countsAsSale({ status: 'exception', payment: paid, settlement: { id: 'run' } })).toBe(true);
  });

  it('leaves out payments that never made a sale, even with a capture id', () => {
    expect(countsAsSale({ status: 'pending_payment', payment: { captureId: null } })).toBe(false);
    // PayPal declined a pending capture: the capture id stays on the payment.
    expect(countsAsSale({ status: 'payment_failed', payment: paid })).toBe(false);
    // A capture that arrived after the checkout had closed: no settlement was ever calculated.
    expect(countsAsSale({ status: 'exception', payment: paid, settlement: null })).toBe(false);
  });
});
