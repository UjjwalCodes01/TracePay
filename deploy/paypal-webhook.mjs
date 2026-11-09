// Registers TracePay's PayPal (sandbox) webhook for a new address, with the same event types as
// the existing one, and prints only the new webhook id. Idempotent: an existing registration for
// the address is reused. Reads credentials from the env file in TRACEPAY_ENV_FILE; prints no secret.
//   TRACEPAY_ENV_FILE=production.env node deploy/paypal-webhook.mjs https://<service>.run.app/api/webhooks/paypal
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const target = process.argv[2];
if (!target?.startsWith('https://')) throw new Error('Usage: node paypal-webhook.mjs https://…/api/webhooks/paypal');
const env = parseEnv(readFileSync(process.env.TRACEPAY_ENV_FILE ?? '.local/render.env', 'utf8'));
const base = env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

const auth = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64');
const tokenRes = await fetch(`${base}/v1/oauth2/token`, { method: 'POST', headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
if (!tokenRes.ok) throw new Error(`PayPal token: HTTP ${tokenRes.status}`);
const { access_token: token } = await tokenRes.json();
const api = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });

const { webhooks = [] } = await (await api('/v1/notifications/webhooks')).json();
const existing = webhooks.find((w) => w.url === target);
if (existing) {
  console.error(`Already registered for ${target}.`);
  console.log(existing.id);
  process.exit(0);
}
const template = webhooks.find((w) => w.url.endsWith('/api/webhooks/paypal'));
if (!template) throw new Error('No existing TracePay webhook to copy event types from.');
const res = await api('/v1/notifications/webhooks', { method: 'POST', body: JSON.stringify({ url: target, event_types: template.event_types.map((e) => ({ name: e.name })) }) });
const body = await res.json();
if (!res.ok) throw new Error(`PayPal webhook: HTTP ${res.status} ${body.name ?? ''} ${body.message ?? ''}`);
console.error(`Registered ${target} for ${body.event_types.length} event types.`);
console.log(body.id);
