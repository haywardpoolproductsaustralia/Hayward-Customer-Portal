import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/au-orders-inbox-auth";
import { listIntake } from "@/lib/au-orders-inbox";
import { redis, getJSON } from "@/lib/redis";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const agent = await requireAgent();
  if (!agent) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const includeKeyed = new URL(req.url).searchParams.get("includeKeyed") === "1";

  // Emails that are queued but not yet extracted, or that failed extraction,
  // never became orders — so they're invisible on this page and look like
  // orders that simply never arrived. Report the counts so they can't be lost
  // silently, and hand back the last few failures for diagnosis.
  const [orders, profiles, pending, failed, failedTail] = await Promise.all([
    listIntake({ includeKeyed }),
    // Address Arrow holds for the matched account, so an agent can see at a
    // glance whether the debtor on the card is plausible for where the order
    // is going. Attached here rather than stored on the record: the record is
    // a snapshot of the email, and the account's address can change under it.
    getJSON<Record<string, {
      street?: string | null; suburb?: string | null; city?: string | null;
      state?: string | null; postcode?: string | null;
    }>>("customerProfiles"),
    redis.llen("soq:pending").catch(() => 0),
    redis.llen("soq:failed").catch(() => 0),
    redis.lrange<string>("soq:failed", -5, -1).catch(() => [] as string[]),
  ]);

  // Compact one-line form: "10 Grex Ave, Minchinbury NSW 2770". Chain accounts
  // carry the group's BILLING address in Arrow (every Reece branch reads
  // Burwood 3125), so this will often differ from the delivery address without
  // anything being wrong — the card labels it as the account address rather
  // than implying a mismatch.
  const compact = (p?: {
    street?: string | null; suburb?: string | null; city?: string | null;
    state?: string | null; postcode?: string | null;
  }) => {
    if (!p) return null;
    const line = [p.street, p.suburb ?? p.city, p.state, p.postcode]
      .map((v) => (v ?? "").trim())
      .filter(Boolean)
      .join(", ");
    return line || null;
  };

  const withAccountAddress = orders.map((o) => ({
    ...o,
    accountAddress: o.debtorCode ? compact(profiles?.[o.debtorCode]) : null,
  }));

  return NextResponse.json({
    orders: withAccountAddress,
    meId: agent.userId,
    meName: agent.name,
    queue: { pending, failed, failedTail },
  });
}
