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

  // Build one representative code per group — strongly preferring an AU
  // branch over NZ. Without this, the first code Redis returns wins,
  // which can be a NZ branch (e.g. Poolwerx Auckland) even when there
  // are 297 AU alternatives.
  const groupBestCode = new Map<string, string>();

  for (const [code, groupName] of Object.entries(codeToGroup)) {
    const profile = customerProfiles?.[code];
    const isNZ = ['NEW ZEALAND', 'NZ'].includes(
      (profile?.state ?? '').toUpperCase()
    );

    if (!groupBestCode.has(groupName)) {
      // No representative yet — take anything
      groupBestCode.set(groupName, code);
    } else if (isNZ) {
      // Current candidate is better (or equal) — skip NZ codes
      continue;
    } else {
      // This is an AU code — prefer it over whatever we had
      const existingCode = groupBestCode.get(groupName)!;
      const existingIsNZ = ['NEW ZEALAND', 'NZ'].includes(
        (customerProfiles?.[existingCode]?.state ?? '').toUpperCase()
      );
      if (existingIsNZ) groupBestCode.set(groupName, code);
    }
  }

  const customers: ({ code: string; name: string } & Partial<CustomerProfile>)[] = [];

  for (const [groupName, code] of groupBestCode) {
    const profile = customerProfiles?.[code];
    customers.push({ code, name: groupName, ...profile });
  }

  customers.sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ customers, isAggregate: true });
}
