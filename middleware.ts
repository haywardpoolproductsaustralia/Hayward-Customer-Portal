import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
     '/sign-in(.*)',
     '/api/au-orders-inbox/ingest',
     '/api/au-orders-inbox/process',
     // Container tracking: the Vercel cron (GET, Bearer CRON_SECRET) and the Power Automate mailbox flow
     // (POST, x-ingest-secret) carry no Clerk session — the routes check their own secrets.
     '/api/containers/refresh',
     '/api/containers/ingest',
   ]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: ['/((?!_next|.*\\..*).*)'],
};
