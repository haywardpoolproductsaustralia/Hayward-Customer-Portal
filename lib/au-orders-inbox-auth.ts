import { auth, currentUser } from "@clerk/nextjs/server";

/**
 * Only Hayward internal staff should see / work the order intake queue.
 * `org_3FkCOPQRTCIuDtVHLXAwhCVyJtZ` is the Hayward aggregate org in your
 * lib/access.ts (ORG_ID_TO_GROUP, displayName 'Hayward', isAggregate: true).
 * Override with the HAYWARD_ORG_ID env var if you ever rotate it.
 */
const HAYWARD_ORG_ID = process.env.HAYWARD_ORG_ID ?? "org_3FkCOPQRTCIuDtVHLXAwhCVyJtZ";

export interface Agent {
  userId: string;
  name: string;
}

export async function requireAgent(): Promise<Agent | null> {
  const { userId, orgId } = await auth();
  if (!userId || orgId !== HAYWARD_ORG_ID) return null;

  const u = await currentUser();
  const name =
    [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim() ||
    u?.username ||
    u?.primaryEmailAddress?.emailAddress ||
    "Staff";
  return { userId, name };
}
