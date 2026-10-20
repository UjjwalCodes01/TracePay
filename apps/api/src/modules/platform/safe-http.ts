import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * Outbound HTTP for webhook deliveries, hardened against SSRF: a customer-chosen
 * URL must never reach this server's own network (cloud metadata, internal
 * services, localhost).
 *
 *  - Only http(s); http only when explicitly allowed (local development).
 *  - Every address the hostname resolves to is checked AT CONNECTION TIME, inside
 *    the socket's DNS lookup, so a DNS answer can't change between the check and
 *    the connect (DNS rebinding).
 *  - Redirects are never followed; a 3xx counts as a failed delivery.
 *  - A hard deadline, and the response body is read only up to a small cap.
 */

const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 96], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) BLOCKED.addSubnet(addr, prefix, 'ipv6');

/** True for addresses on the public internet. IPv4-mapped IPv6 is judged by its IPv4 address. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !BLOCKED.check(address, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return !BLOCKED.check(mapped[1]!, 'ipv4');
    // ::ffff:a00:1 style (hex) mapped addresses.
    if (/^::ffff:/i.test(address)) return false;
    return !BLOCKED.check(address, 'ipv6');
  }
  return false;
}

export interface UrlPolicy {
  /** Allow http:// (local development only). */
  allowHttp: boolean;
  /** Allow private/loopback targets (local development and tests only). */
  allowPrivate: boolean;
}

/** Validates a webhook URL when it is saved; the connection-time check still applies on every delivery. */
export function checkWebhookUrl(raw: string, policy: UrlPolicy): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'Not a valid URL.' };
  }
  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:')) return { ok: false, reason: 'The URL must start with https://.' };
  if (url.username || url.password) return { ok: false, reason: 'The URL must not contain a username or password.' };
  if (url.hash) return { ok: false, reason: 'The URL must not contain a #fragment.' };
  // Webhooks speak HTTPS: no reaching mail, SSH, databases… on someone else's host.
  if (!policy.allowPrivate && url.port) {
    const port = Number(url.port);
    if (port < 1024 && port !== 443 && !(policy.allowHttp && port === 80)) return { ok: false, reason: `Port ${port} isn't allowed. Use 443 or a port from 1024 up.` };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!policy.allowPrivate) {
    if (net.isIP(host) && !isPublicAddress(host)) return { ok: false, reason: 'The URL points at a private or reserved network address.' };
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) return { ok: false, reason: 'The URL points at a local or internal host name.' };
    // A public endpoint has a domain name (or a public IP): single-label names are internal services.
    if (!net.isIP(host) && !host.replace(/\.$/, '').includes('.')) return { ok: false, reason: 'Use the endpoint’s full public domain name.' };
  }
  return { ok: true, url };
}

export type Lookup = typeof dns.lookup;

/**
 * Production DNS for deliveries: c-ares (asynchronous, with its own timeout) rather
 * than getaddrinfo, which runs on libuv's small thread pool — a customer domain
 * whose DNS never answers must not stall password hashing and other pool work.
 */
const resolver = new dns.promises.Resolver({ timeout: 2_500, tries: 2 });
// Public resolvers, not the host's: customer URLs must never resolve this platform's
// internal service names (which would also let errors reveal what exists inside).
resolver.setServers(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']);
const caresLookup = ((hostname: string, _options: unknown, callback: (err: NodeJS.ErrnoException | null, addresses?: dns.LookupAddress[]) => void) => {
  void Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]).then(([v4, v6]) => {
    const list: dns.LookupAddress[] = [
      ...(v4.status === 'fulfilled' ? v4.value.map((address) => ({ address, family: 4 })) : []),
      ...(v6.status === 'fulfilled' ? v6.value.map((address) => ({ address, family: 6 })) : []),
    ];
    if (list.length === 0) return callback(Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }));
    callback(null, list);
  });
}) as unknown as Lookup;

export interface PostResult {
  statusCode: number | null;
  /** First bytes of the response body (UTF-8, truncated). */
  body: string;
  error: string | null;
  durationMs: number;
}

export async function safePost(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
  opts: UrlPolicy & { timeoutMs: number; maxResponseBytes: number; lookup?: Lookup },
): Promise<PostResult> {
  const started = Date.now();
  const done = (r: Omit<PostResult, 'durationMs'>): PostResult => ({ ...r, durationMs: Date.now() - started });

  const checked = checkWebhookUrl(rawUrl, opts);
  if (!checked.ok) return done({ statusCode: null, body: '', error: checked.reason });
  const url = checked.url;
  // The OS resolver (hosts file, localhost) only where private targets are allowed: local development.
  const baseLookup = opts.lookup ?? (opts.allowPrivate ? dns.lookup : caresLookup);

  // Runs inside the socket connect: whatever is resolved here is what gets dialled.
  const guardedLookup = ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    baseLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = (addresses as unknown as dns.LookupAddress[]) ?? [];
      if (list.length === 0) return callback(Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }));
      if (!opts.allowPrivate && list.some((a) => !isPublicAddress(a.address))) {
        return callback(Object.assign(new Error(`${hostname} resolves to a private or reserved address`), { code: 'EBLOCKED' }));
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0]!.address, list[0]!.family);
    });
  }) as unknown as Lookup;

  return new Promise<PostResult>((resolve) => {
    let settled = false;
    const finish = (r: Omit<PostResult, 'durationMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(done(r));
    };
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body).toString(), ...headers },
        lookup: guardedLookup,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          if (size >= opts.maxResponseBytes) return;
          chunks.push(chunk);
          size += chunk.length;
          // Enough to show the receiver's answer; stop reading the rest.
          if (size >= opts.maxResponseBytes) res.destroy();
        });
        const end = () =>
          finish({ statusCode: res.statusCode ?? null, body: Buffer.concat(chunks).subarray(0, opts.maxResponseBytes).toString('utf8'), error: null });
        res.on('end', end);
        res.on('close', end);
        res.on('error', end);
      },
    );
    const deadline = setTimeout(() => {
      req.destroy(Object.assign(new Error(`Timed out after ${opts.timeoutMs} ms`), { code: 'ETIMEDOUT' }));
    }, opts.timeoutMs);
    req.on('error', (err: NodeJS.ErrnoException) => finish({ statusCode: null, body: '', error: describeError(err) }));
    req.end(body);
  });
}

/** What a customer sees about a failed connection: the cause, never addresses we resolved. */
function describeError(err: NodeJS.ErrnoException): string {
  if (err.code === 'EBLOCKED' || err.code === 'ETIMEDOUT') return err.message.replace(/\S+ resolves/, 'The host name resolves');
  const known: Record<string, string> = {
    ENOTFOUND: 'The host name could not be found (DNS).',
    EAI_AGAIN: 'The host name could not be resolved right now (DNS).',
    ECONNREFUSED: 'The endpoint refused the connection.',
    ECONNRESET: 'The endpoint closed the connection.',
    EHOSTUNREACH: 'The endpoint is unreachable.',
    ENETUNREACH: 'The endpoint is unreachable.',
    EPROTO: 'TLS handshake failed.',
    CERT_HAS_EXPIRED: 'The endpoint’s TLS certificate has expired.',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'The endpoint uses a self-signed TLS certificate.',
    SELF_SIGNED_CERT_IN_CHAIN: 'The endpoint’s TLS certificate chain is not trusted.',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'The endpoint’s TLS certificate could not be verified.',
    ERR_TLS_CERT_ALTNAME_INVALID: 'The endpoint’s TLS certificate does not match its host name.',
  };
  return known[err.code ?? ''] ?? `Could not connect to the endpoint${err.code ? ` (${err.code})` : ''}.`;
}
