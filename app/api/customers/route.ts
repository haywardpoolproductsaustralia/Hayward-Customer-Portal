import { NextRequest, NextResponse } from 'next/server';
import { getCustomerAccess } from '@/lib/access';
import { getJSON } from '@/lib/redis';

// Display-only relabel for the group picker. Keys are lowercase; the lookup
// normalizes case so it matches whatever the sync stored ("Reece" / "REECE").
// code is untouched, so pricing resolves identically.
const GROUP_LABELS: Record<string, string> = {
  'reece': 'Reece Group',
  // Pool Systems / Poolwerx already read as their group name. Uncomment
  // to give them a suffix too:
  // 'pool systems': 'Pool Systems Group',
  // 'poolwerx': 'Poolwerx Group',
};

function displayGroupName(groupName: string): string {
  return GROUP_LABELS[groupName.trim().toLowerCase()] ?? groupName;
}

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

  // scope=mine - every account code THIS login actually holds, whether or not
  // it's the aggregate org. Used by the order form's "deliver to account"
  // picker: a customer has to be able to say which of their own branches is
  // ordering, and both modes below deliberately return nothing for a
  // non-aggregate org, so neither of them can serve that.
  if (req.nextUrl.searchParams.get('scope') === 'mine') {
    const [names, profiles] = await Promise.all([
      getJSON<Record<string, string>>('customerNames'),
      getJSON<Record<string, CustomerProfile>>('customerProfiles'),
    ]);
    const customers = access.customerCodes
      .map((code) => {
        const profile = profiles?.[code];
        return { code, ...profile, name: names?.[code] ?? profile?.name ?? code };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ customers, isAggregate: access.isAggregate, scope: 'mine' });
  }

  if (!access.isAggregate) {
    return NextResponse.json({ customers: [], isAggregate: false });
  }

  const level = req.nextUrl.searchParams.get('level') === 'branch' ? 'branch' : 'group';
  const customerNames = await getJSON<Record<string, string>>('customerNames');

  if (level === 'branch') {
    // Every individual branch this login can see, each with its own profile
    // attached (price type, address, contact) so a branch pick carries the
    // same detail a group pick does — the branch's real name takes priority
    // over the profile name so e.g. "REECE DANDENONG" stays distinct.
    const branchProfiles = await getJSON<Record<string, CustomerProfile>>('customerProfiles');
    const customers = access.customerCodes
      .map((code) => {
        const profile = branchProfiles?.[code];
        return { code, ...profile, name: customerNames?.[code] ?? profile?.name ?? code };
      })
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
    customers.push({ code, ...profile, name: displayGroupName(groupName) });
  }

  customers.sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ customers, isAggregate: true });
}
