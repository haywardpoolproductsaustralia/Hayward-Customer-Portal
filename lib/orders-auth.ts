import { auth, currentUser } from "@clerk/nextjs/server";

/**
 * Only Hayward staff (your internal org) should see / work the order queue.
 * Set HAYWARD_ORG_ID to your internal Clerk org id, OR replace the check below
 * with your existing lib/access.ts staff logic (ORG_ID_TO_GROUP etc.).
 */
const HAYWARD_ORG_ID = process.env.HAYWARD_ORG_ID;

export interface Agent {
  userId: string;
  name: string;
}

export async function requireAgent(): Promise<Agent | null> {
  const { userId, orgId } = await auth();
  if (!userId) return null;
  if (HAYWARD_ORG_ID && orgId !== HAYWARD_ORG_ID) return null; // not staff

  const u = await currentUser();
  const name =
    [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim() ||
    u?.username ||
    u?.primaryEmailAddress?.emailAddress ||
    "Agent";
  return { userId, name };
}
