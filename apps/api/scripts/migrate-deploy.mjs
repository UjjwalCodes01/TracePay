// `prisma migrate deploy` with retries for transient connection failures.
//
// Render runs this before every start. A serverless database (Neon) may still be
// waking its compute, or a connection can drop on the way; neither should fail a
// deploy. Only connection errors are retried: a failing migration stops at once.
import { spawnSync } from 'node:child_process';

const CONNECTION_ERRORS = /\b(P1001|P1002|P1017)\b/; // unreachable · timed out · closed
const ATTEMPTS = 5;

for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  const run = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { encoding: 'utf8' });
  process.stdout.write(run.stdout ?? '');
  process.stderr.write(run.stderr ?? '');
  if (run.status === 0) process.exit(0);

  const transient = CONNECTION_ERRORS.test(`${run.stdout}${run.stderr}`);
  if (!transient || attempt === ATTEMPTS) process.exit(run.status ?? 1);
  const waitSeconds = 2 * attempt;
  console.error(`Database not reachable (attempt ${attempt}/${ATTEMPTS}); retrying in ${waitSeconds}s…`);
  await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
}
