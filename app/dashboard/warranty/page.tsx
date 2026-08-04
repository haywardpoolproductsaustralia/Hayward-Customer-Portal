// app/dashboard/warranty/page.tsx
//
// Server gate for the warranty jobs page. Same shape as portal-orders/page.tsx:
// a thin server component that decides whether the route is allowed, then hands
// off to the client UI in ./tickets.
//
// Hiding the nav link is not enough on its own - a bookmarked or shared URL
// still resolves - so the redirect here is the actual enforcement, and
// /api/warranty-tickets refuses the same groups so the JSON can't be fetched
// directly either.

import { redirect } from 'next/navigation';
import { getCustomerAccess } from '@/lib/access';
import { isPageHidden } from '@/lib/page-visibility';
import WarrantyTickets from './tickets';

export const dynamic = 'force-dynamic';

export default async function WarrantyPage() {
  const access = await getCustomerAccess();

  // No org selected: the dashboard layout already shows the "pick an
  // organization" prompt, so bounce to Home rather than render an empty page.
  if (!access) redirect('/dashboard');

  if (isPageHidden('/dashboard/warranty', access.groupKey, access.isAggregate)) {
    redirect('/dashboard');
  }

  return <WarrantyTickets />;
}
