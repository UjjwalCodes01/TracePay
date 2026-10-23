import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../../db';
import { softResetDemo } from './soft-reset';
import { newWorldId } from './world';

/**
 * Private demo worlds: each visitor of a hosted demo gets their own copy of the demo (publisher,
 * buyer, contributors, sources, licenses), so judges trying it at the same time never see or reset
 * each other's progress. The visitor's browser holds "<world>.<secret>"; only the secret's hash is
 * stored, and a world's personas can be assumed only with it.
 */

export const DEMO_WORLD_HEADER = 'x-demo-world';
/** "lastSeenAt" is refreshed at most this often, so an active world doesn't write on every request. */
const TOUCH_EVERY_MS = 60 * 60_000;

const hash = (secret: string) => createHash('sha256').update(secret).digest();

export async function createDemoWorld(db: Db): Promise<{ world: string; token: string }> {
  const world = newWorldId(randomBytes);
  const secret = randomBytes(24).toString('base64url');
  await db.demoWorld.create({ data: { id: world, secretHash: hash(secret).toString('hex') } });
  await softResetDemo(db, world);
  return { world, token: `${world}.${secret}` };
}

/** The world a "<world>.<secret>" token opens, or null. */
export async function verifyDemoWorld(db: Db, token: string | undefined): Promise<string | null> {
  const m = /^([a-z0-9]{12})\.([A-Za-z0-9_-]{20,64})$/.exec(token?.trim() ?? '');
  if (!m) return null;
  const row = await db.demoWorld.findUnique({ where: { id: m[1]! } });
  if (!row) return null;
  const expected = Buffer.from(row.secretHash, 'hex');
  const given = hash(m[2]!);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (Date.now() - row.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    await db.demoWorld.update({ where: { id: row.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }
  return row.id;
}
