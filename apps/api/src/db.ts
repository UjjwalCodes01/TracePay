import { PrismaPg } from '@prisma/adapter-pg';
import { type Prisma, PrismaClient } from './generated/prisma/client';
import { serverEnv } from './config/env';

export type Db = PrismaClient;
/** A transaction client; the root client is also accepted where no transaction is needed. */
export type Tx = Prisma.TransactionClient;

let prisma: PrismaClient | null = null;

export function db(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: serverEnv().DATABASE_URL }) });
  }
  return prisma;
}
