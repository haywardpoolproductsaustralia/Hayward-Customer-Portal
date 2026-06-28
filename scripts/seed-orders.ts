/**
 * Optional: seed sample orders from a terminal instead of the /api/orders/seed route.
 * Needs UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN in the environment.
 *   npx tsx scripts/seed-orders.ts
 */
import { seedSampleOrders } from "../lib/orders-seed";

seedSampleOrders()
  .then((n) => { console.log(`Seeded ${n} sample orders.`); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
