import { NextRequest, NextResponse } from 'next/server';
import { getCustomerAccess } from '@/lib/access';
import { getJSON } from '@/lib/redis';

// Display-only relabel for the group buttons. Keys are lowercase; the lookup
// normalizes case so it matches whatever the sync stored ("Reece" / "REECE").
// code is untouched, so pricing resolves identically.
const GROUP_LABELS: Record<string, string> = {
  'reece': 'Reece Group',
  'poolwerx': 'Poolwerx Group',
  'pool systems': 'Pool Systems Group',
};

function displayGroupName(groupName: string): string {
  const key = groupName.trim().toLowerCase();
  if (GROUP_LABELS[key]) return GROUP_LABELS[key];
  // Anything not explicitly mapped still reads as a group.
  return /group$/i.test(groupName.trim()) ? groupName : `${groupName} Group`;
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
  deleted?: boolean;
}

export interface CustomerGroupOption {
  groupName: string;
  code: string;
  memberCount: number;
  priceType: string | null;
  priceTypes: string[];
  /** False when members disagree on AUTO_PRICE_TYPE, which makes a
   *  group-level price ambiguous. The UI must not hide this. */
  priceTypeConsistent: boolean;
}

const isNZ = (p?: CustomerProfile) =>
  ['NEW ZEALAND', 'NZ'].includes((p?.state ?? '').toUpperCase());

// Customer lists for the header picker and the lookup page.
//
//   scope=mine     ONLY the accounts this login may order against. Scoped to
//                  the caller's own group/branch, never the whole file — a
//                  Poolwerx login must not see Reece's accounts, or anyone
//                  else's. Used by the order form on the quote builder.
//   (no level)     every account in Arrow, lean (code + name + priceType),
//                  plus one entry per customer group. Used by CustomerPicker,
//                  which is aggregate-only (Hayward staff).
//   level=branch   every account with its full profile. Used by the lookup
//                  page, which needs phone/address to verify a caller.
//   level=group    groups only, in the old shape. Kept for compatibility.
//
// All modes are aggregate-org (Hayward staff) only.
//
// IMPORTANT: these read customerNames/customerProfiles, which are written by
// portal-sync's syncCustomerNames(). That function must be pulling ALL of
// DRSMAST — if it's still filtered to the configured group codes, most of
// Arrow's accounts will be missing here no matter what this route does.
export async function GET(req: NextRequest) {
  const access = await getCustomerAccess();
  if (!access) {
    return NextResponse.json({ error: 'No organization selected' }, { status: 403 });
  }

  const level = req.nextUrl.searchParams.get('level');
  const scope = req.nextUrl.searchParams.get('scope');

  /* ---- scope=mine: what THIS login may order against -------------------- */
  // Runs before the aggregate check, because an ordinary distributor login has
  // to be able to see its own accounts even though it can't see the file.
  // access.customerCodes is [branchCode] for a branch login, the group's codes
  // for a head office, and every code for the Hayward aggregate org — the same
  // list /api/orders/submit validates the posted debtorCode against, so
  // anything offered here is guaranteed to be accepted.
  if (scope === 'mine') {
    const [names, profiles] = await Promise.all([
      getJSON<Record<string, string>>('customerNames'),
      getJSON<Record<string, CustomerProfile>>('customerProfiles'),
    ]);
    const customers = access.customerCodes
      .filter((code) => !profiles?.[code]?.deleted)
      .map((code) => ({
        code,
        name: names?.[code] ?? profiles?.[code]?.name ?? code,
        street: profiles?.[code]?.street ?? null,
        suburb: profiles?.[code]?.suburb ?? null,
        city: profiles?.[code]?.city ?? null,
        state: profiles?.[code]?.state ?? null,
        postcode: profiles?.[code]?.postcode ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ customers, scope: 'mine', isAggregate: access.isAggregate });
  }

  if (!access.isAggregate) {
    return NextResponse.json({ customers: [], groups: [], isAggregate: false });
  }

  const [customerNames, customerProfiles, codeToGroup] = await Promise.all([
    getJSON<Record<string, string>>('customerNames'),
    getJSON<Record<string, CustomerProfile>>('customerProfiles'),
    getJSON<Record<string, string>>('codeToGroup'),
  ]);

  const names = customerNames ?? {};
  const profiles = customerProfiles ?? {};

  // Deleted accounts can't be ordered against, so they're not selectable.
  const liveCodes = Object.keys(names).filter((code) => !profiles[code]?.deleted);

  /* ---- groups ---------------------------------------------------------- */

  const membersByGroup = new Map<string, string[]>();
  for (const [code, groupName] of Object.entries(codeToGroup ?? {})) {
    if (!names[code] || profiles[code]?.deleted) continue;
    if (!membersByGroup.has(groupName)) membersByGroup.set(groupName, []);
    membersByGroup.get(groupName)!.push(code);
  }

  const groups: CustomerGroupOption[] = [];
  for (const [groupName, codes] of membersByGroup) {
    // Prefer an AU branch as the representative. Without this the first code
    // Redis happens to return wins, which can be a NZ branch even when there
    // are hundreds of AU alternatives.
    const representative = codes.find((c) => !isNZ(profiles[c])) ?? codes[0];

    // Whether a group price is meaningful at all. If members disagree on
    // AUTO_PRICE_TYPE then pricing "as the group" is really pricing as one
    // arbitrary branch, and the answer would be wrong for the others.
    const priceTypes = [...new Set(codes.map((c) => profiles[c]?.priceType).filter(Boolean) as string[])].sort();
    const consistent = priceTypes.length <= 1;

    groups.push({
      groupName: displayGroupName(groupName),
      code: representative,
      memberCount: codes.length,
      priceType: consistent ? priceTypes[0] ?? null : null,
      priceTypes,
      priceTypeConsistent: consistent,
    });
  }
  groups.sort((a, b) => a.groupName.localeCompare(b.groupName));

  /* ---- old group-only shape -------------------------------------------- */

  if (level === 'group') {
    const customers = groups.map((g) => ({
      code: g.code,
      ...profiles[g.code],
      name: g.groupName,
    }));
    return NextResponse.json({ customers, groups, isAggregate: true });
  }

  /* ---- full profiles (lookup page) ------------------------------------- */

  if (level === 'branch') {
    const customers = liveCodes
      .map((code) => ({ code, ...profiles[code], name: names[code] ?? profiles[code]?.name ?? code }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ customers, groups, isAggregate: true });
  }

  /* ---- default: lean list of every account, for the picker ------------- */

  // Deliberately lean. This loads in the header on every page, and the full
  // profile for ~3,000 accounts is close to a megabyte; the picker only needs
  // enough to list, search and price. Full detail comes from ?level=branch or
  // is already on the selected record.
  const customers = liveCodes
    .map((code) => ({
      code,
      name: names[code] ?? profiles[code]?.name ?? code,
      priceType: profiles[code]?.priceType ?? null,
      suburb: profiles[code]?.suburb ?? null,
      state: profiles[code]?.state ?? null,
      groupName: codeToGroup?.[code] ? displayGroupName(codeToGroup[code]) : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ customers, groups, isAggregate: true, total: customers.length });
}
