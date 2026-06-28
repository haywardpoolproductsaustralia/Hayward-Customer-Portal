/**
 * Optional CLI seed (needs UPSTASH_REDIS_REST_URL + _TOKEN in env):
 *   npx tsx scripts/seed-au-orders-inbox.ts
 */
import { seedSampleIntake } from "../lib/au-orders-inbox-seed";

seedSampleIntake()
  .then((n) => { console.log(`Seeded ${n} sample sales orders.`); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
