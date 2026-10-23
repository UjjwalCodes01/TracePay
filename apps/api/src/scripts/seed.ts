import { db } from '../db';
import { resetAndSeed } from '../modules/demo/seed';
import { DEMO_USERS, WORLD_PREFIX } from '../modules/demo/world';

// resetAndSeed empties every table. Refuse, unless explicitly forced, on a database
// that has real accounts (anyone who isn't a seeded demo persona) or captured PayPal
// payments: that history can't be recreated.
const force = process.argv.includes('--force');
// Demo personas, of the shared demo and of visitors' private worlds, are not real accounts.
const realUsers = await db().user.count({ where: { id: { notIn: DEMO_USERS.map((u) => u.id) }, NOT: { id: { startsWith: WORLD_PREFIX } } } });
const captures = await db().payPalPayment.count({ where: { captureId: { not: null } } });
if ((realUsers > 0 || captures > 0) && !force) {
  console.error(
    `✗ Refusing to seed: this database has ${realUsers} real account(s) and ${captures} captured payment(s), and seeding erases ALL data.\n` +
      '  To restore just the demo data, use "Reset demo" in the app (it never touches real accounts).\n' +
      '  To wipe everything anyway: npm run db:seed -w @tracepay/api -- --force',
  );
  await db().$disconnect();
  process.exit(1);
}

const result = await resetAndSeed(db());
console.log(`✓ Demo data seeded: ${result.users} users, ${result.assets} assets, ${result.chunks} chunks`);
await db().$disconnect();
