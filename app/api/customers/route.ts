import { NextRequest, NextResponse } from 'next/server';
import { getCustomerAccess } from '@/lib/access';
import { getJSON } from '@/lib/redis';

export interface CustomerProfile {
  name: string;
  contactName: string | null;
  phone: string | null;
  street: string | null;
  suburb: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  priceType: string | null;
}

// Lists customers for a picker. Two modes:
//
// - level=group (default) - one entry per real customer (18, not 479),
//   deduped via the codeToGroup map, with full profile details attached
//   (phone, address, AUTO_PRICE_TYPE) - used for the "pricing for"
//   picker, since every branch within a group shares one price type.
// - level=branch - every individual code this login can see, with its
//   real name only (no profile). Used for things like customer notes,
//   where per-branch granularity genuinely matters.
//
// Both only return anything for an aggregate org (Hayward) - an ordinary
// single-group head office has nothing useful to pick between either way.
export async function GET(req: NextRequest) {
  const access = await getCustomerAccess();
  if (!access) {
    return NextResponse.json({ error: 'No organization selected' }, { status: 403 });
  }

  if (!access.isAggregate) {
    return NextResponse.json({ customers: [], isAggregate: false });
  }

  const level = req.nextUrl.searchParams.get('level') === 'branch' ? 'branch' : 'group';
  const customerNames = await getJSON<Record<string, string>>('customerNames');

  if (level === 'branch') {
    const customers = access.customerCodes
      .map((code) => ({ code, name: customerNames?.[code] ?? code }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ customers, isAggregate: true });
  }

  const [codeToGroup, customerProfiles] = await Promise.all([
    getJSON<Record<string, string>>('codeToGroup'),
    getJSON<Record<string, CustomerProfile>>('customerProfiles'),
  ]);

  if (!codeToGroup || Object.keys(codeToGroup).length === 0) {
    return NextResponse.json({
      customers: [],
      isAggregate: true,
      error: 'codeToGroup not yet populated - run the sync job on AZ-Grey',
    });
  }

  // For aggregate orgs, read codeToGroup directly rather than going
  // through access.customerCodes (which requires group:Hayward:codes to
  // be populated). codeToGroup already has every real customer code and
  // their group name, so we can build the deduplicated group list from
  // it without any other dependency.
  const seenGroups = new Set<string>();
  const customers: ({ code: string; name: string } & Partial<CustomerProfile>)[] = [];

  for (const [code, groupName] of Object.entries(codeToGroup)) {
    if (seenGroups.has(groupName)) continue;
    seenGroups.add(groupName);
    const profile = customerProfiles?.[code];
    customers.push({ code, name: groupName, ...profile });
  }

  customers.sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ customers, isAggregate: true });
}
