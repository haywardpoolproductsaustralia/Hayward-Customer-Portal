import { redirect } from "next/navigation";
import { requireAgent } from "@/lib/au-orders-inbox-auth";
import PortalOrderQueue from "./queue";

export const dynamic = "force-dynamic";

export default async function PortalOrdersPage() {
  const agent = await requireAgent();
  if (!agent) redirect("/dashboard");
  return <PortalOrderQueue meId={agent.userId} meName={agent.name} />;
}
