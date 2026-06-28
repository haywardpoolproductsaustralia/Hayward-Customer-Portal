import { redirect } from "next/navigation";
import { requireAgent } from "@/lib/au-orders-inbox-auth";
import OrderInboxQueue from "./queue";

export const dynamic = "force-dynamic";

export default async function AuOrdersInboxPage() {
  const agent = await requireAgent();
  if (!agent) redirect("/dashboard");
  return <OrderInboxQueue meId={agent.userId} meName={agent.name} />;
}
