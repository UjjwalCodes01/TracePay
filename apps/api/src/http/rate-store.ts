import type { Options, Store } from 'express-rate-limit';
import { createClient } from 'redis';
import { logger } from './logger';

/**
 * Rate-limit counters, shared by every API instance through Redis (on Render: a
 * Key Value instance, REDIS_URL). Without it each instance counts in its own
 * memory, so running two would double every limit and quota.
 *
 * Limits fail OPEN: if Redis is unreachable a request is let through (and logged)
 * rather than the API going down with it. Every call is bounded by a short timeout.
 */

const TIMEOUT_MS = 500;

/** Count a hit; start the window on the first one. One round trip, atomic. */
const INCREMENT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { hits, ttl }`;

const connect = (url: string) =>
  createClient({
    url,
    // Fail fast while disconnected: a request must never wait on Redis coming back.
    disableOfflineQueue: true,
    socket: { connectTimeout: 5_000, reconnectStrategy: (attempt: number) => Math.min(250 * 2 ** attempt, 10_000) },
  });
type Client = ReturnType<typeof connect>;
let client: Client | null | undefined;

function sharedClient(): Client | null {
  if (client !== undefined) return client;
  const url = process.env.REDIS_URL?.trim();
  if (!url) return (client = null);
  const c = connect(url);
  let lastLogged = 0;
  c.on('error', (err: Error) => {
    if (Date.now() - lastLogged < 60_000) return; // once a minute is enough while it's down
    lastLogged = Date.now();
    logger.warn({ err: err.message }, 'rate-limit store (Redis) unavailable; limits are failing open');
  });
  c.connect().catch(() => undefined); // retried by reconnectStrategy; errors are logged above
  return (client = c);
}

async function send<T>(c: Client, args: string[]): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      c.sendCommand(args) as Promise<T>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('rate-limit store timed out')), TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class RedisLimitStore implements Store {
  readonly prefix: string;
  private windowMs = 60_000;

  constructor(
    private readonly c: Client,
    name: string,
  ) {
    this.prefix = `tracepay:rl:${name}:`;
  }

  init(options: Options) {
    this.windowMs = options.windowMs;
  }

  async increment(key: string) {
    const [hits, ttl] = await send<[number, number]>(this.c, ['EVAL', INCREMENT, '1', this.prefix + key, String(this.windowMs)]);
    return { totalHits: Number(hits), resetTime: new Date(Date.now() + Number(ttl)) };
  }

  async decrement(key: string) {
    await send(this.c, ['DECR', this.prefix + key]);
  }

  async resetKey(key: string) {
    await send(this.c, ['DEL', this.prefix + key]);
  }
}

/**
 * Options to spread into every `rateLimit({...})`: a shared Redis store when
 * REDIS_URL is set, the default in-memory store otherwise. `name` keeps each
 * limiter's counters apart.
 */
export function limitStore(name: string): { store?: Store; passOnStoreError: boolean } {
  const c = sharedClient();
  return c ? { store: new RedisLimitStore(c, name), passOnStoreError: true } : { passOnStoreError: true };
}

/** Whether limits are shared across instances right now (for /api/ready). */
export function limitStoreStatus(): 'memory' | 'shared' | 'unavailable' {
  const c = sharedClient();
  if (!c) return 'memory';
  return c.isReady ? 'shared' : 'unavailable';
}

export async function closeLimitStore(): Promise<void> {
  if (client) await client.close().catch(() => undefined);
  client = undefined;
}
