import { describe, expect, it } from 'vitest';
import { PayPalApiError, PayPalClient } from '../src/integrations/paypal/client';

interface Call {
  url: string;
  init: RequestInit;
}

/** A scripted fetch: each entry is the response for the next non-token call. */
function fakePayPal(responses: Array<{ status: number; body: unknown } | Error>, scope = 'openid https://uri.paypal.com/services/payments/payouts') {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (url.endsWith('/v1/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600, scope }), { status: 200 });
    }
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error('unexpected call');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'paypal-debug-id': 'dbg123' } });
  }) as unknown as typeof fetch;
  return { client: new PayPalClient('id', 'secret', fetchImpl), calls };
}

const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];

describe('PayPal client', () => {
  it('detects whether the app has the Payouts scope', async () => {
    expect(await fakePayPal([]).client.hasPayoutsScope()).toBe(true);
    expect(await fakePayPal([], 'openid').client.hasPayoutsScope()).toBe(false);
  });

  it('retries a capture after a 5xx with the same PayPal-Request-Id', async () => {
    const { client, calls } = fakePayPal([
      { status: 503, body: { name: 'SERVICE_UNAVAILABLE' } },
      { status: 201, body: { id: 'O1', status: 'COMPLETED', links: [] } },
    ]);
    const order = await client.captureOrder('O1', 'capture-O1');
    expect(order.status).toBe('COMPLETED');
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => header(c, 'PayPal-Request-Id'))).toEqual(['capture-O1', 'capture-O1']);
  });

  it('never auto-retries a payout POST (the service owns retries with the same sender_batch_id)', async () => {
    const { client, calls } = fakePayPal([new TypeError('fetch failed')]);
    await expect(client.createPayoutBatch({ senderBatchId: 'run_1', emailSubject: 's', emailMessage: 'm', items: [] })).rejects.toThrow('fetch failed');
    expect(calls).toHaveLength(1);
  });

  it('puts a deadline on every PayPal call', async () => {
    const { client, calls } = fakePayPal([{ status: 200, body: { id: 'O1', status: 'CREATED', links: [] } }]);
    await client.getOrder('O1');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not retry client errors and surfaces the PayPal issue', async () => {
    const { client, calls } = fakePayPal([
      { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', message: 'bad', details: [{ issue: 'ORDER_NOT_APPROVED' }] } },
    ]);
    const err = await client.captureOrder('O1', 'k').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect((err as PayPalApiError).issue).toBe('ORDER_NOT_APPROVED');
    expect((err as PayPalApiError).debugId).toBe('dbg123');
    expect(calls).toHaveLength(1);
  });

  it('embeds the raw webhook body verbatim when verifying signatures', async () => {
    const { client, calls } = fakePayPal([{ status: 200, body: { verification_status: 'SUCCESS' } }]);
    const raw = '{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"amount":{"value":"20.00"}}}';
    const ok = await client.verifyWebhookSignature(
      'WEBHOOK_ID',
      { authAlgo: 'SHA256withRSA', certUrl: 'https://c', transmissionId: 't1', transmissionSig: 'sig', transmissionTime: 'now' },
      raw,
    );
    expect(ok).toBe(true);
    expect(calls[0]!.init.body as string).toContain(`"webhook_event":${raw}}`);
  });
});
