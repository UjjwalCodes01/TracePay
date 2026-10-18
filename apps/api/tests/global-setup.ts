import { execSync } from 'node:child_process';
import pg from 'pg';

/**
 * When TEST_DATABASE_URL is set, make sure that database exists and is
 * migrated. Integration suites are skipped entirely when it isn't set.
 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;

  const target = new URL(url);
  const dbName = target.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';

  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
  await client.end();

  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'ignore' });
}
