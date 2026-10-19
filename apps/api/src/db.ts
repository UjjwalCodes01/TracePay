import { PrismaPg } from '@prisma/adapter-pg';
import { type Prisma, PrismaClient } from './generated/prisma/client';
import { serverEnv } from './config/env';
import { logger } from './http/logger';

export type Db = PrismaClient;
/** A transaction client; the root client is also accepted where no transaction is needed. */
export type Tx = Prisma.TransactionClient;

let prisma: PrismaClient | null = null;

export function db(): PrismaClient {
  if (!prisma) {
    const env = serverEnv();
    const adapter = new PrismaPg(
      {
        connectionString: env.DATABASE_URL,
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
    prisma = new PrismaClient({ adapter });
  }
  return prisma;
}
