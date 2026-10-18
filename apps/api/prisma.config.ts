import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Generation doesn't need a live database; migrate/seed do.
    url: process.env.DATABASE_URL ?? 'postgresql://tracepay:tracepay@localhost:5433/tracepay',
  },
});
