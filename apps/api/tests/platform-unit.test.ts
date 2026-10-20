import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENT_TYPES, publicEventFor } from '../src/modules/platform/events';
import { checkWebhookUrl, isPublicAddress, safePost, type Lookup } from '../src/modules/platform/safe-http';
import { computeSignature, SecretBox, signatureHeader, verifyWebhookSignature } from '../src/modules/platform/webhook-crypto';
import { WebhookReceiver } from './webhook-receiver';

const strict = { allowHttp: false, allowPrivate: false };
const local = { allowHttp: true, allowPrivate: true };
const lookupTo = (address: string, family = 4): Lookup =>
  ((_host: string, _opts: unknown, cb: (err: null, addrs: { address: string; family: number }[]) => void) => cb(null, [{ address, family }])) as unknown as Lookup;

describe('webhook signatures', () => {
  const secret = 'whsec_test_secret';
  const body = '{"id":"evt_1","type":"ping"}';
  const t = 1_800_000_000;

  it('verifies a genuine signature and rejects every kind of tampering', () => {
    const header = signatureHeader([secret], t, body);
    expect(verifyWebhookSignature({ header, body, secret, now: t })).toBe(true);
    expect(verifyWebhookSignature({ header, body: body.replace('ping', 'pong'), secret, now: t })).toBe(false);
    expect(verifyWebhookSignature({ header, body, secret: 'whsec_other', now: t })).toBe(false);
    // Timestamp is part of the MAC: changing it breaks the signature.
    expect(verifyWebhookSignature({ header: header.replace(`t=${t}`, `t=${t + 1}`), body, secret, now: t })).toBe(false);
  });

  it('rejects replays outside the tolerance window, in either direction', () => {
    const header = signatureHeader([secret], t, body);
    expect(verifyWebhookSignature({ header, body, secret, now: t + 299 })).toBe(true);
    expect(verifyWebhookSignature({ header, body, secret, now: t + 301 })).toBe(false);
    expect(verifyWebhookSignature({ header, body, secret, now: t - 301 })).toBe(false);
  });

  it('accepts either signature during a secret rotation', () => {
    const header = signatureHeader(['whsec_new', 'whsec_old'], t, body);
    expect(header.match(/v1=/g)).toHaveLength(2);
    expect(verifyWebhookSignature({ header, body, secret: 'whsec_new', now: t })).toBe(true);
    expect(verifyWebhookSignature({ header, body, secret: 'whsec_old', now: t })).toBe(true);
  });

  it('rejects malformed headers without throwing', () => {
    for (const header of [undefined, '', 'v1=abc', `t=${t}`, `t=abc,v1=${computeSignature(secret, t, body)}`, `t=${t},v1=zz`, `t=${t},v1=${'0'.repeat(63)}`]) {
      expect(verifyWebhookSignature({ header, body, secret, now: t })).toBe(false);
    }
  });
});

describe('secret encryption at rest', () => {
  it('round-trips, uses a fresh IV each time, and detects tampering', () => {
    const box = SecretBox.forTests();
    const a = box.seal('whsec_abc');
    const b = box.seal('whsec_abc');
    expect(a).not.toBe(b);
    expect(a).not.toContain('whsec_abc');
    expect(box.open(a)).toBe('whsec_abc');
    const [v, iv, ct, tag] = a.split('.');
    const flipped = Buffer.from(ct!, 'base64url');
    flipped[0]! ^= 1;
    expect(() => box.open([v, iv, flipped.toString('base64url'), tag].join('.'))).toThrow();
    expect(() => SecretBox.forTests().open(a)).toThrow(); // another key
    expect(() => box.open('garbage')).toThrow();
  });

  it('accepts a 32-byte key as hex or base64, refuses anything else, and derives one otherwise', () => {
    const key = randomBytes(32);
    const hex = SecretBox.fromEnv(key.toString('hex'), '');
    const b64 = SecretBox.fromEnv(key.toString('base64'), '');
    expect(b64.open(hex.seal('x'))).toBe('x');
    expect(() => SecretBox.fromEnv(randomBytes(16).toString('base64'), '')).toThrow(/32 bytes/);
    const derivedA = SecretBox.fromEnv(undefined, 'signing-key-material');
    const derivedB = SecretBox.fromEnv('  ', 'signing-key-material');
    expect(derivedB.open(derivedA.seal('y'))).toBe('y');
    expect(() => SecretBox.fromEnv(undefined, 'other-material').open(derivedA.seal('y'))).toThrow();
  });

  it('keeps old secrets readable when a key is added or rotated', () => {
    const sealedWithDerived = SecretBox.fromEnv(undefined, 'signing-key-material').seal('whsec_old');
    const k1 = randomBytes(32).toString('base64');
    const withKey = SecretBox.fromEnv(k1, 'signing-key-material');
    expect(withKey.open(sealedWithDerived)).toBe('whsec_old');
    const sealedWithK1 = withKey.seal('whsec_new');
    expect(SecretBox.fromEnv(undefined, 'signing-key-material').open(sealedWithDerived)).toBe('whsec_old');
    // Rotating to k2: k1 secrets stay readable only if k1 is listed as previous.
    const k2 = randomBytes(32).toString('hex');
    expect(() => SecretBox.fromEnv(k2, 'signing-key-material').open(sealedWithK1)).toThrow(/any configured key/);
    expect(SecretBox.fromEnv(k2, 'signing-key-material', k1).open(sealedWithK1)).toBe('whsec_new');
  });
});

describe('SSRF policy', () => {
  it('classifies addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
      '255.255.255.255', '::1', '::', '::7f00:1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:a00:1::', 'not-an-ip',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('validates URLs when they are saved', () => {
    expect(checkWebhookUrl('https://hooks.example.com/tracepay', strict).ok).toBe(true);
    const bad: [string, RegExp][] = [
      ['http://hooks.example.com', /https/],
      ['ftp://hooks.example.com', /https/],
      ['https://user:pw@hooks.example.com', /username/],
      ['https://hooks.example.com/#x', /fragment/],
      ['https://127.0.0.1/x', /private/],
      ['https://[::1]/x', /private/],
      ['https://169.254.169.254/latest/meta-data', /private/],
      ['https://localhost/x', /local/],
      ['https://api.internal/x', /local/],
      ['https://tracepay-db:5432/x', /full public domain/],
      ['https://redis/x', /full public domain/],
      ['not a url', /valid URL/],
    ];
    for (const [url, reason] of bad) {
      const r = checkWebhookUrl(url, strict);
      expect(r.ok, url).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(reason);
    }
    expect(checkWebhookUrl('http://127.0.0.1:9/x', local).ok).toBe(true);
    // Only HTTPS-ish ports: no talking to mail, SSH or databases on someone else's host.
    for (const ok of ['https://hooks.example.com:443/x', 'https://hooks.example.com:8443/x', 'https://hooks.example.com:3000/x']) expect(checkWebhookUrl(ok, strict).ok, ok).toBe(true);
    for (const bad of ['https://hooks.example.com:25/x', 'https://hooks.example.com:22/x', 'https://hooks.example.com:80/x', 'https://hooks.example.com:0/x']) {
      const r = checkWebhookUrl(bad, strict);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/Port/);
    }
  });
});

describe('safePost', () => {
  const receiver = new WebhookReceiver();
  beforeAll(() => receiver.start());
  afterAll(() => receiver.stop());
  const post = (url: string, opts: Partial<Parameters<typeof safePost>[3]> = {}) =>
    safePost(url, '{"a":1}', { 'x-test': '1' }, { ...local, timeoutMs: 1_000, maxResponseBytes: 64, ...opts });

  it('posts JSON and reports the status and (truncated) response', async () => {
    receiver.reset();
    receiver.status(200, 'x'.repeat(1_000));
    const r = await post(receiver.url());
    expect(r.statusCode).toBe(200);
    expect(r.body.length).toBeLessThanOrEqual(64);
    expect(receiver.received[0]!.body).toBe('{"a":1}');
    expect(receiver.received[0]!.headers['content-type']).toBe('application/json');
    expect(receiver.received[0]!.headers['x-test']).toBe('1');
  });

  it('never follows redirects', async () => {
    receiver.reset();
    receiver.respond((_req, res) => res.writeHead(302, { location: 'http://169.254.169.254/' }).end());
    const r = await post(receiver.url());
    expect(r.statusCode).toBe(302);
    expect(receiver.received).toHaveLength(1);
  });

  it('gives up at the deadline', async () => {
    receiver.reset();
    receiver.respond(() => undefined); // never answers
    const r = await post(receiver.url(), { timeoutMs: 200 });
    expect(r.statusCode).toBeNull();
    expect(r.error).toMatch(/Timed out/);
  });

  it('blocks private targets at connection time, including via DNS (rebinding)', async () => {
    receiver.reset();
    // An IP literal…
    expect((await post(receiver.url(), strict)).error).toMatch(/https|private/);
    // …and a public-looking name that resolves to loopback when the connection is made.
    const viaDns = await post(`https://rebind.example.test:${receiver.port}/x`, { ...strict, lookup: lookupTo('127.0.0.1') });
    expect(viaDns.statusCode).toBeNull();
    expect(viaDns.error).toMatch(/private or reserved/);
    const mapped = await post(`https://mapped.example.test:${receiver.port}/x`, { ...strict, lookup: lookupTo('::ffff:10.0.0.1', 6) });
    expect(mapped.error).toMatch(/private or reserved/);
    expect(receiver.received).toHaveLength(0);
  });

  it('reports connection failures as errors, not crashes', async () => {
    const r = await post('http://127.0.0.1:1/x');
    expect(r.statusCode).toBeNull();
    expect(r.error).toMatch(/refused the connection/);
    expect(r.error).not.toMatch(/127\.0\.0\.1/);
  });
});

describe('public event catalog', () => {
  it('maps audit events to thin public events with only allowed fields, in snake_case', () => {
    const e = publicEventFor({
      entityType: 'sale',
      entityId: 'sale_1',
      eventType: 'sale.captured',
      artifactId: 'art_1',
      payload: { via: 'capture_call', orderId: 'O1', captureId: 'C1', capturedCents: 2000, paypalFeeCents: 88, problems: [], payeeEmail: 'x@y.example' },
    });
    expect(e).toEqual({ type: 'sale.completed', data: { object_type: 'sale', object_id: 'sale_1', report_id: 'art_1', order_id: 'O1', capture_id: 'C1', captured_cents: 2000 } });
  });

  it('keeps internal audit events internal', () => {
    for (const eventType of ['retrieved', 'cited', 'demo.reset', 'asset.registered', 'something.new']) {
      expect(publicEventFor({ entityType: 'build', entityId: 'b', eventType, payload: {} })).toBeNull();
    }
    expect(publicEventFor({ entityType: 'system', entityId: 'demo', eventType: 'settlement.approved', payload: {} })).toBeNull();
  });

  it('snake-cases nested fields and documents every type', () => {
    const e = publicEventFor({ entityType: 'build', entityId: 'b1', eventType: 'build.preflight_blocked', payload: { failedRules: [{ ruleId: 'COMMERCIAL_USE', assetVersionId: 'av1' }] } });
    expect(e?.data.failed_rules).toEqual([{ rule_id: 'COMMERCIAL_USE', asset_version_id: 'av1' }]);
    expect(EVENT_TYPES.length).toBeGreaterThan(30);
    expect(new Set(EVENT_TYPES.map((t) => t.type)).size).toBe(EVENT_TYPES.length);
    for (const t of EVENT_TYPES) expect(t.description.length).toBeGreaterThan(10);
  });
});
