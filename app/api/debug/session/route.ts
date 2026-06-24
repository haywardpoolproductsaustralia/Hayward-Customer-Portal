import { NextResponse } from 'next/server';
import { clerkClient } from '@clerk/nextjs/server';

// TEMPORARY diagnostic endpoint - lists every Clerk Organization with its
// stable ID, so we can map ID -> customer group reliably instead of
// depending on the orgName shortcode (which isn't resolving correctly).
// Delete this once the org-ID mapping is built.
export async function GET() {
  const client = await clerkClient();
  const list = await client.organizations.getOrganizationList({ limit: 100 });

  const orgs = list.data.map((org) => ({
    id: org.id,
    name: org.name,
    slug: org.slug,
    membersCount: org.membersCount,
  }));

  return NextResponse.json({ count: orgs.length, orgs });
}
