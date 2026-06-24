import { NextResponse } from 'next/server';
import { getCustomerAccess } from '@/lib/access';
import { getJSON } from '@/lib/redis';

// Lists the customers a "pricing for" picker should offer.
//
// Only meaningful for an aggregate org (Hayward, currently the only one) -
// every branch within a real customer group shares the exact same price
// type as its head office, so letting someone pick between 479 individual
// branch codes would be pure noise with zero actual effect on the price
// shown. Instead, this groups codes back to their real customer (via the
// codeToGroup map the sync job builds) and returns one representative
// code per group - 18 real choices instead of 479 meaningless ones.
//
// For an ordinary single-group head office, there's nothing useful to
// pick between at all (every branch already matches), so this returns
// an empty list and the picker UI simply doesn't render.
export async function GET() {
  const access = await getCustomerAccess();
  if (!access) {
    return NextResponse.json({ error: 'No organization selected' }, { status: 403 });
  }

  if (!access.isAggregate) {
    return NextResponse.json({ customers: [], isAggregate: false });
  }

  const [customerNames, codeToGroup] = await Promise.all([
    getJSON<Record<string, string>>('customerNames'),
    getJSON<Record<string, string>>('codeToGroup'),
  ]);

  const seenGroups = new Set<string>();
  const customers: { code: string; name: string }[] = [];

  for (const code of access.customerCodes) {
    const groupName = codeToGroup?.[code];
    if (!groupName || seenGroups.has(groupName)) continue;
    seenGroups.add(groupName);
    customers.push({ code, name: groupName });
  }

  customers.sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ customers, isAggregate: true });
}
