import { auth } from '@clerk/nextjs/server';
import { getJSON } from './redis';

// Maps each Clerk Organization's stable ID to the matching key in
// portal-sync/config/customer-groups.json, plus a friendly display name.
//
// IDs are used here instead of the org's name because the `orgName`
// custom session-token shortcode wasn't resolving correctly - it was
// returning the literal text "{{organization.name}}" instead of the
// actual name. Organization ID, by contrast, comes from Clerk's default
// session claims (auth().orgId) and needs no custom shortcode at all,
// so it doesn't depend on that broken mechanism.
//
// Update this if a group is renamed, recreated, or a new customer is
// onboarded - it must stay in sync with both Clerk's Organizations list
// and portal-sync/config/customer-groups.json.
const ORG_ID_TO_GROUP: Record<string, { groupKey: string; displayName: string; isAggregate?: boolean }> = {
  org_3FWBvIWbOTuSElJBoHDld0Ot6ei: { groupKey: 'Reece', displayName: 'Reece' },
  org_3FWC4rJyCAWsAdyGXeoEMbG894C: { groupKey: 'Poolwerx', displayName: 'Poolwerx' },
  org_3FWC65qfMobPhnZBDTnKyDAbz7V: { groupKey: 'PoolSystems', displayName: 'Pool Systems' },
  org_3FWC78NSvWRnlAjIKbyXDNB3h9M: { groupKey: 'Lincoln', displayName: 'Lincoln' },
  org_3FWC7pDq5hfbVmb9qjT4kXhttCp: { groupKey: 'Austral', displayName: 'Austral' },
  org_3FWC8kUv9dVqf36qMm56dI6DPpB: { groupKey: 'Dolphin', displayName: 'Dolphin' },
  org_3FWC9cPk1sZfG79MVkDXZ20SCyD: { groupKey: 'Rainbow', displayName: 'Rainbow' },
  org_3FWCAVWUOAX4ySOYgIlOQuwzA9Z: { groupKey: 'PoolwaterProducts', displayName: 'Poolwater Products' },
  org_3FWCBPseymU4I0RKxb65WtftEst: { groupKey: 'PoolRanger', displayName: 'Pool Ranger' },
  org_3FWCCHZPl5b0YndJCjyGSOra9nm: { groupKey: 'PoolPro', displayName: 'Pool Pro' },
  org_3FWCD7xMQa7W9CKacKZfnKNXu4x: { groupKey: 'Legend', displayName: 'Legend' },
  org_3FWCE0ASb08gqcY8tz0nGDESSb0: { groupKey: 'International', displayName: 'International' },
  org_3FWCEnTkI67v70wPkDAAewiO3q1: { groupKey: 'Evolution', displayName: 'Evolution' },
  org_3FWCFeCxQGBucFTiW25Gwj9HyKF: { groupKey: 'Eclipse', displayName: 'Eclipse' },
  org_3FWCGOHnsfwpM0N41nfnMCqrgDM: { groupKey: 'Eagles', displayName: 'Eagles' },
  org_3FWCHT2hvn39unvzJioqotHa0N1: { groupKey: 'AZPools', displayName: 'A-Z Pools' },
  org_3FWG2xzxgqm35j6Y3C3419jpbZb: { groupKey: 'PoolSpaWarehouse', displayName: 'Pool & Spa Warehouse' },
  org_3FWG3cp9MADKgjC356dt2jSVcSn: { groupKey: 'Compass', displayName: 'Compass' },
  // TODO: add the real Hayward org ID once it's created in Clerk, e.g.:
  // org_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXX: { groupKey: 'Hayward', displayName: 'Hayward', isAggregate: true },
  // Test Org intentionally excluded - not a real customer group.
};

export interface CustomerAccess {
  groupName: string;
  groupKey: string;
  isHeadOffice: boolean;
  isAggregate: boolean;
  branchCode: string | null;
  customerCodes: string[];
}

// The branchCode shortcode has the same unresolved-template problem as
// orgName did. Until that's fixed in Clerk's claims config, treat any
// value that still looks like a literal "{{...}}" placeholder as if it
// were never set, rather than accidentally scoping someone to a fake
// single "customer code" that's actually just garbage template text.
function isResolvedValue(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && !v.startsWith('{{');
}

/**
 * Resolves the current request's logged-in user to the set of Arrow
 * customer codes they're allowed to see, based on their active Clerk
 * Organization (matched by ID) and, if resolved correctly, a branchCode
 * on their membership.
 */
export async function getCustomerAccess(): Promise<CustomerAccess | null> {
  const { orgId, sessionClaims } = await auth();
  if (!orgId) return null;

  const group = ORG_ID_TO_GROUP[orgId];
  if (!group) return null;

  const rawBranchCode = sessionClaims?.branchCode;
  const branchCode = isResolvedValue(rawBranchCode) ? rawBranchCode : null;

  if (branchCode) {
    return {
      groupName: group.displayName,
      groupKey: group.groupKey,
      isHeadOffice: false,
      isAggregate: false,
      branchCode,
      customerCodes: [branchCode],
    };
  }

  // Head office (or a single-site customer with no branch split at all):
  // every code in the group, resolved live from what the sync job cached.
  const customerCodes = (await getJSON<string[]>(`group:${group.groupKey}:codes`)) ?? [];

  return {
    groupName: group.displayName,
    groupKey: group.groupKey,
    isHeadOffice: true,
    isAggregate: Boolean(group.isAggregate),
    branchCode: null,
    customerCodes,
  };
}
