import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';

// TEMPORARY diagnostic endpoint - shows exactly what the server sees for
// the current session, with no interpretation. Delete this once the
// access-resolution bug is found; it's not meant to stay in the app
// long-term (session internals shouldn't normally be exposed like this).
export async function GET() {
  const a = await auth();
  return NextResponse.json({
    userId: a.userId,
    orgId: a.orgId,
    orgRole: a.orgRole,
    orgSlug: a.orgSlug,
    sessionClaims: a.sessionClaims,
  });
}
