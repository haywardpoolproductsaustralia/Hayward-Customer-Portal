import { auth } from '@clerk/nextjs/server';
import { getJSON } from './redis';

// Maps each Clerk Organization's display name to the matching key in
// portal-sync/config/customer-groups.json (and therefore the matching
// group:{groupKey}:codes key in Redis). Update this if a group is renamed
// or a new customer is onboarded - it must stay in sync with that config file.
const ORG_NAME_TO_GROUP_KEY: Record<string, string> = {
  Reece: 'Reece',
  Poolwerx: 'Poolwerx',
  'Pool Systems': 'PoolSystems',
  Lincoln: 'Lincoln',
  Austral: 'Austral',
  Dolphin: 'Dolphin',
  Rainbow: 'Rainbow',
  'Poolwater Products': 'PoolwaterProducts',
  'Pool Ranger': 'PoolRanger',
  'Pool Pro': 'PoolPro',
  Legend: 'Legend',
  International: 'International',
  Evolution: 'Evolution',
  Eclipse: 'Eclipse',
  Eagles: 'Eagles',
  'A-Z Pools': 'AZPools',
  'Pool & Spa Warehouse': 'PoolSpaWarehouse',
  Compass: 'Compass',
};

export interface CustomerAccess {
  groupName: string;
  groupKey: string;
  isHeadOffice: boolean;
  branchCode: string | null;
  /** Every Arrow customer code this logged-in user is allowed to see. */
  customerCodes: string[];
}

/**
 * Resolves the current request's logged-in user to the set of Arrow
 * customer codes they're allowed to see, based on their active Clerk
 * Organization and (if set) a branchCode on their membership.
 *
 * Requires two custom session token claims configured in the Clerk
 * Dashboard (Sessions -> Customize session token):
 *   orgName     -> {{organization.name}}
 *   branchCode  -> {{organization_membership.public_metadata.branchCode}}
 *
 * Returns null if there's no signed-in user, no active organization, or
 * the organization name doesn't match a known customer group.
 */
export async function getCustomerAccess(): Promise<CustomerAccess | null> {
  const { sessionClaims } = await auth();
  if (!sessionClaims) return null;

  const orgName = sessionClaims.orgName as string | undefined;
  const branchCode = (sessionClaims.branchCode as string | undefined) || null;

  if (!orgName) return null;

  const groupKey = ORG_NAME_TO_GROUP_KEY[orgName];
  if (!groupKey) return null;

  // Branch login: scoped to exactly one Arrow code.
  if (branchCode) {
    return {
      groupName: orgName,
      groupKey,
      isHeadOffice: false,
      branchCode,
      customerCodes: [branchCode],
    };
  }

  // Head office (or a single-site customer with no branch split at all):
  // every code in the group, resolved live from what the sync job cached.
  const customerCodes = (await getJSON<string[]>(`group:${groupKey}:codes`)) ?? [];

  return {
    groupName: orgName,
    groupKey,
    isHeadOffice: true,
    branchCode: null,
    customerCodes,
  };
}
