import type { Prisma } from '../../generated/prisma/client';

export interface EventRow {
  id: string;
  type: string;
  data: Prisma.JsonValue;
  createdAt: Date;
}
