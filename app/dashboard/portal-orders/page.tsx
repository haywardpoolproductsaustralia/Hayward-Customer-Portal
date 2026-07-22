import { redirect } from "next/navigation";
import { requireAgent } from "@/lib/au-orders-inbox-auth";
import { PORTAL_ORDERS_ENABLED } from "@/lib/features";
import PortalOrderQueue from "./queue";

export const dynamic = "force-dynamic";

export default async function PortalOrdersPage() {
  // Feature is off — the nav item is hidden, but bounce a bookmarked URL too.
  if (!PORTAL_ORDERS_ENABLED) redirect("/dashboard");

  const agent = await requireAgent();
  if (!agent) redirect("/dashboard");
  return <PortalOrderQueue meId={agent.userId} meName={agent.name} />;
}
