// lib/page-visibility.ts
//
// Per-customer-group page hiding.
//
// This is a BLOCKLIST, deliberately - the default for any group is "sees
// everything in NAV_ITEMS". Only groups that have asked to have a page taken
// away appear here. That way onboarding a new customer needs no edit to this
// file, and forgetting to edit it fails open (they see the page) rather than
// silently locking a new customer out of something they paid for.
//
// Keys are the groupKey from lib/access.ts (the ORG_ID_TO_GROUP value), NOT
// the display name - "PoolSystems", not "Pool Systems".
//
// Reece (all of it, branches AND head office) asked to have the warranty jobs
// page removed, Aug 2026. They run warranty through their own systems and
// didn't want a second place for their branch staff to look.
//
// NOTE ON AGGREGATE ORGS: Hayward's org is a union of every group's customer
// codes, so a code-based check would sweep Hayward up with Reece. The check
// below short-circuits on isAggregate first, so Hayward staff always keep
// every page regardless of what's listed here.
export const HIDDEN_PAGES: Record<string, string[]> = {
  Reece: ['/dashboard/warranty'],
};

/**
 * True when this login must not see `href`.
 *
 * Matches the exact path and anything beneath it, so listing
 * '/dashboard/warranty' also covers a future '/dashboard/warranty/[id]'
 * detail route without another edit here.
 */
export function isPageHidden(
  href: string,
  groupKey?: string | null,
  isAggregate: boolean = false
): boolean {
  if (isAggregate) return false;      // Hayward staff see everything
  if (!groupKey) return false;        // no org selected yet - layout handles it
  const hidden = HIDDEN_PAGES[groupKey];
  if (!hidden) return false;
  return hidden.some((p) => href === p || href.startsWith(`${p}/`));
}

// ---------------------------------------------------------------------------
// Per-group FEATURE hiding - for things that live inside a page rather than
// being a page of their own. Same blocklist rules as HIDDEN_PAGES above:
// default is "has it", Hayward staff (aggregate) always have it.
//
// 'ordering' = placing orders on the portal: the Place order button and panel
// on the quote builder, the "Place an order" nav label, and /api/orders/submit.
// The quote builder itself stays - the group still sees its pricing.
//
// Reece asked not to use portal ordering, Sep 2026. They keep ordering through
// their own channel; staff can still place an order on a Reece account from
// the "Pricing as" picker, since staff logins are aggregate.
// ---------------------------------------------------------------------------
export type PortalFeature = 'ordering';

export const HIDDEN_FEATURES: Record<string, PortalFeature[]> = {
  Reece: ['ordering'],
};

/** True when this login must not have `feature`. */
export function isFeatureHidden(
  feature: PortalFeature,
  groupKey?: string | null,
  isAggregate: boolean = false
): boolean {
  if (isAggregate) return false;
  if (!groupKey) return false;
  return HIDDEN_FEATURES[groupKey]?.includes(feature) ?? false;
}
