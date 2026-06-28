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
// NOTE: These are the PRODUCTION instance org IDs (clerk.portal-hayward.com).
// Production orgs were recreated fresh and received brand-new IDs that do
// NOT match the old development instance. If you ever spin up a new instance
// or recreate an org, re-harvest IDs (e.g. via the Clerk dashboard or a
// backend org list) and update this map.
//
// Update this if a group is renamed, recreated, or a new customer is
// onboarded - it must stay in sync with both Clerk's Organizations list
// and portal-sync/config/customer-groups.json.
const ORG_ID_TO_GROUP: Record<string, { groupKey: string; displayName: string; isAggregate?: boolean }> = {
  org_3FXoIQcXtB67hl99tCaw2TLsujA: { groupKey: 'Reece', displayName: 'Reece' },
  org_3FXoLbi8bppSMRfGOOddA15wOEM: { groupKey: 'Poolwerx', displayName: 'Poolwerx' },
  org_3FXoMcm542U2i1MlpS70gZ1acY0: { groupKey: 'PoolSystems', displayName: 'Pool Systems' },
  org_3FXoNQ2lSHNlo3SKgxUZvYJqNHm: { groupKey: 'Lincoln', displayName: 'Lincoln' },
  org_3FXoOHl4f2EbnPdJkxLctGXvlJ5: { groupKey: 'Austral', displayName: 'Austral' },
  org_3FXoOv8Hwxz98CjYKgE4wqMEFbv: { groupKey: 'Dolphin', displayName: 'Dolphin' },
  org_3FXoPhSizbC7vjV7EfSTIq7FPye: { groupKey: 'Rainbow', displayName: 'Rainbow' },
  org_3FXoQaqpeHV2Yd9kRO2yezbZpQ7: { groupKey: 'PoolwaterProducts', displayName: 'Poolwater Products' },
  org_3FXoRNmRkeb2m9zxJW47tGDBq37: { groupKey: 'PoolRanger', displayName: 'Pool Ranger' },
  org_3FXoSFvgGkDS5hsxEzVksAbVYuA: { groupKey: 'PoolPro', displayName: 'Pool Pro' },
  org_3FXoSzd2FI5pVCTjfRt53V8dxhA: { groupKey: 'Legend', displayName: 'Legend' },
  org_3FXoTmKiD23OMtXgkAndTUWzOHC: { groupKey: 'International', displayName: 'International' },
  org_3FXoUeuPmvIwKPhhkBF6OhP15pD: { groupKey: 'Evolution', displayName: 'Evolution' },
  org_3FXoVDyaf2XuvLDgY9DBrGGfsZp: { groupKey: 'Eclipse', displayName: 'Eclipse' },
  org_3FXoVz1ROrx71NMqUczDeUpqIxm: { groupKey: 'Eagles', displayName: 'Eagles' },
  org_3FXoXP7hTrIzCR3Ju04twjCk3cD: { groupKey: 'AZPools', displayName: 'A-Z Pools' },
  org_3FkCebllwiLs18S36g5jt5xTb8a: { groupKey: 'PoolSpaWarehouse', displayName: 'Pool & Spa Warehouse' },
  org_3FkCgxlVfMXEJ2Kl9Q0xqkLVdgd: { groupKey: 'Compass', displayName: 'Compass' },
  org_3FkCOPQRTCIuDtVHLXAwhCVyJtZ: { groupKey: 'Hayward', displayName: 'Hayward', isAggregate: true },
  // testorg (org_3FXoaO7oKb6VcioyqvVrFsOjpNQ) intentionally excluded - not a real customer group.
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
  let customerCodes = (await getJSON<string[]>(`group:${group.groupKey}:codes`)) ?? [];

  // Aggregate orgs (Hayward) fall back to reading all codes from codeToGroup
  // when group:Hayward:codes hasn't been populated yet (e.g. customer-groups.json
  // on AZ-Grey hasn't been updated, or sync hasn't run since the Hayward group
  // was added). codeToGroup has every real code already, so this is equivalent.
  if (customerCodes.length === 0 && group.isAggregate) {
    const codeToGroup = await getJSON<Record<string, string>>('codeToGroup');
    if (codeToGroup) customerCodes = Object.keys(codeToGroup);
  }

  return {
    groupName: group.displayName,
    groupKey: group.groupKey,
    isHeadOffice: true,
    isAggregate: Boolean(group.isAggregate),
    branchCode: null,
    customerCodes,
  };
}
