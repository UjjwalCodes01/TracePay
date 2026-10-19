import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { defineConfig } from 'prisma/config';

/**
 * The Prisma CLI doesn't load env files, so resolve the connection here with the
 * same precedence as the npm scripts: the real environment (Render, CI, tests), then
 * the repo-root .env.local written by `neon env pull`, then apps/api/.env.
 *
 * Migrations take session-level locks, so they need a DIRECT connection. On Neon
 * that's DATABASE_URL_UNPOOLED (no "-pooler" in the host); the app itself uses the
 * pooled DATABASE_URL. The direct URL is always taken from the same source as
 * DATABASE_URL, so an explicitly set database (e.g. the test DB) is never paired
 * with Neon's URL from a file.
 */
function databaseUrl(): string {
  const fromProcess = process.env.DATABASE_URL;
  if (fromProcess) return withConnectTimeout(process.env.DATABASE_URL_UNPOOLED || fromProcess);

  const files = [path.join(import.meta.dirname, '../../.env.local'), path.join(import.meta.dirname, '.env')];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const vars = parseEnv(readFileSync(file, 'utf8'));
    if (vars.DATABASE_URL) return withConnectTimeout(vars.DATABASE_URL_UNPOOLED || vars.DATABASE_URL);
  }
  // Generation doesn't need a live database; migrate/seed do.
  return 'postgresql://tracepay:tracepay@localhost:5433/tracepay';
}

/** The schema engine gives up after 5 s by default; a waking Neon compute can take longer. */
function withConnectTimeout(url: string): string {
  try {
    const u = new URL(url);
    if (!u.searchParams.has('connect_timeout')) u.searchParams.set('connect_timeout', '30');
    return u.toString();
  } catch {
    return url;
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: databaseUrl(),
  },
});
