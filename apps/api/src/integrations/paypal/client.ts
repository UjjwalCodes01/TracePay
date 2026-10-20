import { randomUUID } from 'node:crypto';
import { paypalEnv } from '../../config/env';
import type {
  Capture,
  CaptureResponse,
  CreateOrderRequest,
  Order,
  PayoutBatchResponse,
  PayoutBatchStatus,
  PayoutItemRequest,
  WebhookVerificationHeaders,
} from './types';

const BASE_URL = 'https://api-m.sandbox.paypal.com';
export const REQUEST_TIMEOUT_MS = 25_000;

export class PayPalApiError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
    readonly body: unknown,
    readonly debugId: string | undefined,
  ) {
    const name = (body as { name?: string } | null)?.name ?? 'UNKNOWN';
    const msg = (body as { message?: string } | null)?.message ?? '';
    super(`PayPal ${operation} failed (${status} ${name}): ${msg}${debugId ? ` [debug_id ${debugId}]` : ''}`);
    this.name = 'PayPalApiError';
  }

  get issue(): string | undefined {
    return (this.body as { details?: { issue?: string }[] } | null)?.details?.[0]?.issue;
  }

  /** 5xx and 429 are safe to retry with the same idempotency key. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 429;
  }
}

interface CachedToken {
  value: string;
  expiresAt: number;
  scopes: string[];
}

/**
 * Minimal PayPal REST client (sandbox). Every mutating call carries an
 * idempotency key — PayPal-Request-Id for Orders, sender_batch_id for Payouts —
 * so a retry after a lost response can never charge or pay twice.
 */
export class PayPalClient {
  private token: CachedToken | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  static fromEnv(): PayPalClient {
    const env = paypalEnv();
    return new PayPalClient(env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET);
  }

  // ---- auth ------------------------------------------------------------------

  async accessToken(): Promise<CachedToken> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token;
    const res = await this.fetchImpl(`${BASE_URL}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const body = (await res.json().catch(() => null)) as
      | { access_token: string; expires_in: number; scope: string }
      | null;
    if (!res.ok || !body) throw new PayPalApiError(res.status, 'oauth2/token', body, res.headers.get('paypal-debug-id') ?? undefined);
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000, scopes: body.scope.split(' ') };
    return this.token;
  }

  /** Whether the app's credentials carry the Payouts scope (checked before we promise payouts). */
  async hasPayoutsScope(): Promise<boolean> {
    const { scopes } = await this.accessToken();
    return scopes.some((s) => s.includes('/payouts'));
  }

  // ---- orders v2 ---------------------------------------------------------------

  createOrder(req: CreateOrderRequest, requestId: string): Promise<Order> {
    return this.call('orders.create', 'POST', '/v2/checkout/orders', req, {
      'PayPal-Request-Id': requestId,
      Prefer: 'return=representation',
    });
  }

  getOrder(orderId: string): Promise<Order> {
    return this.call('orders.get', 'GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }

  captureOrder(orderId: string, requestId: string): Promise<CaptureResponse> {
    return this.call('orders.capture', 'POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, undefined, {
      'PayPal-Request-Id': requestId,
      Prefer: 'return=representation',
    });
  }

  /** The current state of a capture — how reconciliation notices refunds made outside TracePay. */
  getCapture(captureId: string): Promise<Capture> {
    return this.call('captures.get', 'GET', `/v2/payments/captures/${encodeURIComponent(captureId)}`);
  }

  // ---- payouts -----------------------------------------------------------------

  /**
   * sender_batch_id is the idempotency key: PayPal rejects a reused id as a
   * duplicate, so on retry we resend the *same* id, never a fresh one.
   */
  createPayoutBatch(args: {
    senderBatchId: string;
    emailSubject: string;
    emailMessage: string;
    items: PayoutItemRequest[];
  }): Promise<PayoutBatchResponse> {
    // Not retried here: a resend after a lost response would be rejected as a
    // duplicate. The settlement service owns retries (same sender_batch_id).
    return this.call(
      'payouts.create',
      'POST',
      '/v1/payments/payouts',
      {
        sender_batch_header: {
          sender_batch_id: args.senderBatchId,
          email_subject: args.emailSubject,
          email_message: args.emailMessage,
          recipient_type: 'EMAIL',
        },
        items: args.items,
      },
      {},
      { retry: false },
    );
  }

  getPayoutBatch(payoutBatchId: string): Promise<PayoutBatchStatus> {
    return this.call('payouts.get', 'GET', `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}?fields=batch_header,items&page_size=100`);
  }

  // ---- webhooks ----------------------------------------------------------------

  /**
   * Verifies a webhook by asking PayPal. The raw request body is embedded
   * verbatim — re-serialising parsed JSON can change bytes and fail verification.
   */
  async verifyWebhookSignature(webhookId: string, headers: WebhookVerificationHeaders, rawBody: string): Promise<boolean> {
    const payload =
      `{"auth_algo":${JSON.stringify(headers.authAlgo)},"cert_url":${JSON.stringify(headers.certUrl)},` +
      `"transmission_id":${JSON.stringify(headers.transmissionId)},"transmission_sig":${JSON.stringify(headers.transmissionSig)},` +
      `"transmission_time":${JSON.stringify(headers.transmissionTime)},"webhook_id":${JSON.stringify(webhookId)},` +
      `"webhook_event":${rawBody}}`;
    const result = await this.call<{ verification_status: string }>(
      'webhooks.verify',
      'POST',
      '/v1/notifications/verify-webhook-signature',
      payload,
    );
    return result.verification_status === 'SUCCESS';
  }

  // ---- transport ---------------------------------------------------------------

  private async call<T>(
    operation: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
    opts: { retry?: boolean } = {},
  ): Promise<T> {
    const maxAttempts = opts.retry === false ? 1 : 3;
    for (let attempt = 1; ; attempt++) {
      try {
        const token = await this.accessToken();
        const res = await this.fetchImpl(`${BASE_URL}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token.value}`,
            'Content-Type': 'application/json',
            ...extraHeaders,
          },
          // A hung call must give up long before the service treats a submission as abandoned.
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
        });
        const text = await res.text();
        const json = text ? (JSON.parse(text) as unknown) : null;
        if (!res.ok) {
          if (res.status === 401) this.token = null;
          throw new PayPalApiError(res.status, operation, json, res.headers.get('paypal-debug-id') ?? undefined);
        }
        return json as T;
      } catch (err) {
        // TypeError = network failure; TimeoutError = our own deadline.
        const retryable = err instanceof PayPalApiError ? err.retryable : err instanceof TypeError || (err as Error).name === 'TimeoutError';
        if (!retryable || attempt >= maxAttempts) throw err;
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
  }
}

export const newRequestId = (): string => randomUUID();
