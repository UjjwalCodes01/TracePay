import type { PayPalClient } from './client';

/** The PayPal operations services depend on — the real client, or a fake in tests. */
export type PayPalGateway = Pick<
  PayPalClient,
  | 'createOrder'
  | 'getOrder'
  | 'captureOrder'
  | 'getCapture'
  | 'createPayoutBatch'
  | 'getPayoutBatch'
  | 'verifyWebhookSignature'
  | 'hasPayoutsScope'
  | 'createSetupToken'
  | 'createPaymentToken'
  | 'deletePaymentToken'
>;
