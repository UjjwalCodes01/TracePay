import { formatMoney } from './format';

export type ActivityTone = 'good' | 'bad' | 'waiting' | 'neutral';

export interface Activity {
  text: string;
  tone: ActivityTone;
}

const money = (v: unknown) => (typeof v === 'number' ? formatMoney(v) : null);

/** Turns a system event into one sentence a non-technical user understands. */
export function describeEvent(eventType: string, payload: Record<string, unknown> = {}): Activity {
  switch (eventType) {
    case 'demo.seeded':
      return { text: 'Demo data was loaded: 5 sources from 5 contributors.', tone: 'neutral' };
    case 'agent.started':
      return { text: 'The assistant started putting together a report.', tone: 'neutral' };
    case 'agent.awaiting_approval':
      return { text: 'The assistant found a replacement source and is waiting for your OK.', tone: 'waiting' };
    case 'agent.replacement_approved':
      return { text: 'You approved swapping in a replacement source.', tone: 'good' };
    case 'agent.replacement_declined':
      return { text: 'You declined the replacement source, so the report was not built.', tone: 'neutral' };
    case 'agent.completed':
      return { text: 'The assistant finished its work.', tone: 'good' };
    case 'agent.failed':
      return { text: 'The assistant stopped because of a problem.', tone: 'bad' };
    case 'build.preflight_blocked':
      return { text: 'A report was stopped: one source’s license doesn’t allow selling it.', tone: 'bad' };
    case 'build.preflight_passed':
      return { text: 'All sources checked out: you’re allowed to sell this report.', tone: 'good' };
    case 'build.generation_rejected':
      return { text: 'A draft was rejected because it referenced a source it didn’t actually use.', tone: 'bad' };
    case 'artifact.generated':
      return { text: 'A new report was created and put up for sale.', tone: 'good' };
    case 'sale.captured':
      return { text: `A buyer paid ${money(payload.capturedCents) ?? ''} with PayPal.`.replace('  ', ' '), tone: 'good' };
    case 'sale.capture_pending':
      return { text: 'A PayPal payment is still being processed.', tone: 'waiting' };
    case 'sale.capture_exception':
      return { text: 'A PayPal payment didn’t match the price and needs checking.', tone: 'bad' };
    case 'sale.refunded':
      return { text: 'A purchase was refunded.', tone: 'bad' };
    case 'sale.reversed':
      return { text: 'A payment was reversed by PayPal.', tone: 'bad' };
    case 'settlement.calculated':
      return { text: `Contributor shares were worked out: ${money(payload.contributorTotalCents) ?? 'an amount'} to pay.`, tone: 'neutral' };
    case 'settlement.approved':
      return { text: 'You approved paying the contributors.', tone: 'good' };
    case 'settlement.completed':
      return { text: 'Nothing was owed to contributors for this sale.', tone: 'neutral' };
    case 'payout.submitted':
      return { text: 'Payments to contributors were sent with PayPal.', tone: 'good' };
    case 'payout.status_refreshed':
      return payload.runStatus === 'completed'
        ? { text: 'PayPal confirmed every contributor has been paid.', tone: 'good' }
        : payload.runStatus === 'exception'
          ? { text: 'PayPal reported a contributor payment that failed or came back.', tone: 'bad' }
          : { text: 'Checked with PayPal: payments are still on their way.', tone: 'waiting' };
    case 'payout.submit_failed':
      return { text: 'Sending payments didn’t go through. It’s safe to try again.', tone: 'bad' };
    case 'payout.duplicate_rejected':
      return { text: 'PayPal blocked a duplicate payment, so nobody was paid twice.', tone: 'waiting' };
    case 'license.requested':
      return { text: 'You asked a contributor for a license.', tone: 'neutral' };
    case 'license.offered':
      return { text: 'A contributor offered you license terms to review.', tone: 'waiting' };
    case 'license.accepted':
      return { text: 'You accepted a license. The source can now be used in reports.', tone: 'good' };
    case 'license.declined':
      return { text: 'You declined a license offer.', tone: 'neutral' };
    case 'license.withdrawn':
      return { text: 'A contributor withdrew a license offer.', tone: 'neutral' };
    case 'license.request_declined':
      return { text: 'A contributor declined your license request.', tone: 'neutral' };
    case 'license.revoked':
      return { text: 'A contributor revoked a license. New reports can’t use that source.', tone: 'bad' };
    default:
      return { text: eventType.replace(/[._]/g, ' '), tone: 'neutral' };
  }
}
