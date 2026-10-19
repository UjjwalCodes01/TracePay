import { PrismaPg } from '@prisma/adapter-pg';
import { type Prisma, PrismaClient } from './generated/prisma/client';
import { serverEnv } from './config/env';
import { logger } from './http/logger';

export type Db = PrismaClient;
/** A transaction client; the root client is also accepted where no transaction is needed. */
export type Tx = Prisma.TransactionClient;

let prisma: PrismaClient | null = null;

/**
 * Hosted Postgres URLs (Neon's included) use sslmode=require. node-postgres 8 treats
 * that as verify-full, but v9 adopts libpq semantics, where "require" encrypts without
 * checking the certificate. Pin verify-full so an upgrade can't silently weaken TLS.
 */
export function withVerifiedTls(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const mode = url.searchParams.get('sslmode');
    if (mode && ['prefer', 'require', 'verify-ca'].includes(mode) && !url.searchParams.has('uselibpqcompat')) {
      url.searchParams.set('sslmode', 'verify-full');
      return url.toString();
    }
  } catch {
    // Not a URL (e.g. a key=value DSN): pass through unchanged.
  }
  return connectionString;
}

export function db(): PrismaClient {
  if (!prisma) {
    const env = serverEnv();
    const adapter = new PrismaPg(
      {
        connectionString: withVerifiedTls(env.DATABASE_URL),
        max: env.DB_POOL_MAX,
        // Serverless Postgres (Neon) suspends when idle; the first connection after
        // that waits for the compute to wake, which can take a few seconds.
        connectionTimeoutMillis: 15_000,
        // Release idle connections well before the server side drops them.
        idleTimeoutMillis: 60_000,
        keepAlive: true,
      },
      {
        // An idle connection closed by the server (compute suspended, pooler restart)
        // must not crash the process; the pool discards it and opens a fresh one.
        onPoolError: (err) => logger.warn({ err }, 'database pool: idle connection closed'),
        onConnectionError: (err) => logger.warn({ err }, 'database connection error'),
      },
    );
    prisma = new PrismaClient({
      adapter,
      // Prisma's defaults (2 s to get a connection, 5 s per transaction) assume a database
      // next door. Audit appends serialise on one advisory lock, so under concurrent
      // writes a transaction can queue behind others; over a network hop (or while a
      // suspended Neon compute wakes) that easily exceeds 5 s. Past these limits the
      // request fails with a retryable 503 (see http/errors.ts).
      transactionOptions: { maxWait: 10_000, timeout: 20_000 },
    });
  }
  return prisma;
}
