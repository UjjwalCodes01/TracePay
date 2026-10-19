import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Migrations take session-level locks, so they need a direct connection. On Neon
    // that is the connection string WITHOUT "-pooler"; the app itself uses DATABASE_URL
    // (pooled). Locally both point at the same Docker database.
    // Generation doesn't need a live database; migrate/seed do.
    url: process.env.DIRECT_URL || process.env.DATABASE_URL || 'postgresql://tracepay:tracepay@localhost:5433/tracepay',
  },
});
