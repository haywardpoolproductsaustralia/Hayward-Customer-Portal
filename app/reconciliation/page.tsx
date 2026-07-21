/* app/reconciliation/page.tsx
   Server component: reads the latest reconciliation snapshot from Redis and
   hands it to the client renderer. Add Clerk auth/role guards here to match
   the rest of the portal.
*/

import { Redis } from "@upstash/redis";
import ReconciliationClient from "./ReconciliationClient";
import type { ReconLine } from "@/lib/recon/reconcile";

export const dynamic = "force-dynamic";

const redis = Redis.fromEnv();

interface Snapshot {
  lines: ReconLine[];
  summary: { total: number; exceptions: number; inTransit: number; delivered: number; awaiting: number; late: number };
  meta: { generatedAt: string; shipmentReceivedAt: string; shipmentSubject: string; arrowLines: number; as400Rows: number };
}

export default async function ReconciliationPage() {
  const snap = (await redis.get<Snapshot>("recon:latest")) ?? null;

  if (!snap) {
    return (
      <div style={{ padding: 40, color: "#8ba0b6", fontFamily: "Inter, system-ui" }}>
        No reconciliation has run yet. Trigger <code>/api/cron/reconcile</code> or wait for the next scheduled run.
      </div>
    );
  }

  return <ReconciliationClient lines={snap.lines} summary={snap.summary} meta={snap.meta} />;
}
