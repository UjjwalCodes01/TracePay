import { db } from '../db';
import { resetAndSeed } from '../modules/demo/seed';

const result = await resetAndSeed(db());
console.log(`✓ Demo data seeded: ${result.users} users, ${result.assets} assets, ${result.chunks} chunks`);
await db().$disconnect();
