import { auth } from '@clerk/nextjs/server';
import { getJSON, redis } from './redis';

// ---------------------------------------------------------------------------
// Catalogues and views — two different things, deliberately
// ---------------------------------------------------------------------------
// CATALOGUE = a Redis namespace, and a PERMISSION boundary.
//
//     stock:all      / stock:{sku}      -> Hayward's own lines (excludes PR and 17300)
//     pr:stock:all   / pr:stock:{sku}   -> Paramount catalogue
//     fc:stock:all   / fc:stock:{sku}   -> Flow Control catalogue
//
//   Paramount stock is written by portal-sync/sync-paramount-stock.js into its
//   own namespace. sync-stock-and-orders.js still excludes PR at the SQL layer
//   (`AND (s.STOCK_CATEGORY IS NULL OR s.STOCK_CATEGORY <> 'PR')`) and that
//   exclusion MUST stay. Separation is structural: an org that isn't permitted
//   Paramount is never handed a pr: key, so there is no read-time filter
//   anywhere that can be forgotten and leak PR stock to Reece.
//
// VIEW = which subset of the SKUs a user already holds is currently on screen.
//   This is the filter-button row: All / Hayward / Paramount / Flow Control.
//   A view NEVER widens access. Asking for the Paramount view without the
//   Paramount catalogue simply returns the Hayward SKUs.
//
// Flow Control was originally a view over stock:*, visible to everyone. As of
// 13 Aug 2026 it is a full catalogue restricted to Hayward staff only, so it
// got the same treatment as Paramount: sync-flowcontrol-stock.js writes
// fc:stock:*, and syncStock excludes SUPPLIER_CODE 17300 from stock:*.
//
// A filter in this file alone would NOT have been enough. Ten other surfaces
// read stock:all directly (dashboard, warehouse fulfillment, warehouse
// duplicates, orders/submit, chat, forecast, warranty-tickets, pricing,
// au-orders-extract), none of which consult this module. The exclusion has to
// happen at the sync or those SKUs stay reachable.

export type Catalogue = 'hayward' | 'paramount' | 'flowcontrol';
export type StockView = 'all' | 'hayward' | 'paramount' | 'flowcontrol';

/** Consolidated list key per catalogue — the "show everything" read. */
export const STOCK_ALL_KEY: Record<Catalogue, string> = {
  hayward: 'stock:all',
  paramount: 'pr:stock:all',
  flowcontrol: 'fc:stock:all',
};

/** Per-SKU key prefix per catalogue. */
export const STOCK_KEY_PREFIX: Record<Catalogue, string> = {
  hayward: 'stock:',
  paramount: 'pr:stock:',
  flowcontrol: 'fc:stock:',
};

/** Display order. Hayward first, so its SKUs lead the merged view. */
export const CATALOGUE_ORDER: readonly Catalogue[] = ['hayward', 'paramount', 'flowcontrol'];

/** Arrow STOCK_CATEGORY for Paramount stock. char(2), confirmed 12 Aug 2026. */
export const PARAMOUNT_CATEGORY = 'PR';

// Flow Control is identified by STKMAST.SUPPLIER_CODE = '17300' (the creditor
// deliberately excluded from the Hayward-family reconciliation scope, which
// covers only 17100 / 17115 / 17125 / 17200). SUPPLIER_CODE is char(6) and so
// space-padded; the sync RTRIMs it and the predicates below trim defensively.
//
// This list must stay in step with three places on AZ-Grey:
//   sync-flowcontrol-stock.js   FC_SUPPLIER_CODES  (what goes into fc:stock:*)
//   sync-stock-and-orders.js    the 17300 exclusion in syncStock's WHERE
//   check-paramount-ready.js    FLOW_CONTROL_SUPPLIER_CODES
// Adding a code here without adding it there leaves those SKUs in stock:all,
// visible to every distributor.
export const FLOW_CONTROL_SUPPLIER_CODES: ReadonlySet<string> = new Set<string>([
  '17300',
]);

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
//
// `catalogues` omitted  -> Hayward's own lines only. Correct for every existing
//                          distributor. Do not add entries casually: listing a
//                          catalogue here grants that stock permanently.
//                          'flowcontrol' is Hayward staff ONLY.
// `showFilters` omitted -> no filter buttons, current UI. Only the three orgs
//                          that hold mixed catalogues get the button row.
const ORG_ID_TO_GROUP: Record<
  string,
  {
    groupKey: string;
    displayName: string;
    isAggregate?: boolean;
    catalogues?: Catalogue[];
    showFilters?: boolean;
  }
> = {
  org_3FXoIQcXtB67hl99tCaw2TLsujA: { groupKey: 'Reece', displayName: 'Reece' },
  org_3FXoLbi8bppSMRfGOOddA15wOEM: { groupKey: 'Poolwerx', displayName: 'Poolwerx' },
  org_3FXoMcm542U2i1MlpS70gZ1acY0: { groupKey: 'PoolSystems', displayName: 'Pool Systems' },
  org_3FXoNQ2lSHNlo3SKgxUZvYJqNHm: { groupKey: 'Lincoln', displayName: 'Lincoln' },
  org_3FXoOHl4f2EbnPdJkxLctGXvlJ5: { groupKey: 'Austral', displayName: 'Austral' },
  org_3FXoOv8Hwxz98CjYKgE4wqMEFbv: { groupKey: 'Dolphin', displayName: 'Dolphin' },
  org_3FXoPhSizbC7vjV7EfSTIq7FPye: { groupKey: 'Rainbow', displayName: 'Rainbow' },

  // Paramount + Hayward. NOT Flow Control — that is Hayward staff only.
  // Granted on business direction (13 Aug 2026): PWP starts buying Paramount
  // from now on, so past order history is deliberately not the test.
  org_3FXoQaqpeHV2Yd9kRO2yezbZpQ7: {
    groupKey: 'PoolwaterProducts',
    displayName: 'Poolwater Products',
    catalogues: ['hayward', 'paramount'],
    showFilters: true,
  },

  org_3FXoRNmRkeb2m9zxJW47tGDBq37: { groupKey: 'PoolRanger', displayName: 'Pool Ranger' },
  org_3FXoSFvgGkDS5hsxEzVksAbVYuA: { groupKey: 'PoolPro', displayName: 'Pool Pro' },
  org_3FXoSzd2FI5pVCTjfRt53V8dxhA: { groupKey: 'Legend', displayName: 'Legend' },
  org_3FXoTmKiD23OMtXgkAndTUWzOHC: { groupKey: 'International', displayName: 'International' },
  org_3FXoUeuPmvIwKPhhkBF6OhP15pD: { groupKey: 'Evolution', displayName: 'Evolution' },
  org_3FXoVDyaf2XuvLDgY9DBrGGfsZp: { groupKey: 'Eclipse', displayName: 'Eclipse' },
  org_3FXoVz1ROrx71NMqUczDeUpqIxm: { groupKey: 'Eagles', displayName: 'Eagles' },
  org_3FXoXP7hTrIzCR3Ju04twjCk3cD: { groupKey: 'AZPools', displayName: 'A-Z Pools' },
  org_3FkCebllwiLs18S36g5jt5xTb8a: { groupKey: 'PoolSpaWarehouse', displayName: 'Pool & Spa Warehouse' },

  // Paramount + Hayward, same as Poolwater Products. NOT Flow Control.
  org_3FkCgxlVfMXEJ2Kl9Q0xqkLVdgd: {
    groupKey: 'Compass',
    displayName: 'Compass',
    catalogues: ['hayward', 'paramount'],
    showFilters: true,
  },

  // Hayward internal staff: everything, including Flow Control. This is the
  // ONLY org that holds the 'flowcontrol' catalogue.
  org_3FkCOPQRTCIuDtVHLXAwhCVyJtZ: {
    groupKey: 'Hayward',
    displayName: 'Hayward',
    isAggregate: true,
    catalogues: ['hayward', 'paramount', 'flowcontrol'],
    showFilters: true,
  },
  // testorg (org_3FXoaO7oKb6VcioyqvVrFsOjpNQ) intentionally excluded - not a real customer group.
};

export interface CustomerAccess {
  groupName: string;
  groupKey: string;
  isHeadOffice: boolean;
  isAggregate: boolean;
  branchCode: string | null;
  customerCodes: string[];

  /** Every catalogue this org may read. The permission boundary. */
  catalogues: Catalogue[];
  /** Whether to render the All / Hayward / Paramount / Flow Control button row. */
  showFilters: boolean;
}

// The branchCode shortcode has the same unresolved-template problem as
// orgName did. Until that's fixed in Clerk's claims config, treat any
// value that still looks like a literal "{{...}}" placeholder as if it
// were never set, rather than accidentally scoping someone to a fake
// single "customer code" that's actually just garbage template text.
function isResolvedValue(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && !v.startsWith('{{');
}

// Hayward is the default when a group declares nothing, so the 16 existing
// distributor entries above behave exactly as they did before this change.
function cataloguesFor(group: { catalogues?: Catalogue[] }): Catalogue[] {
  const list = group.catalogues?.length ? group.catalogues : (['hayward'] as Catalogue[]);
  // De-dupe and pin the order so Hayward SKUs always lead the merged view.
  return CATALOGUE_ORDER.filter((c) => list.includes(c));
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

  const catalogues = cataloguesFor(group);
  const showFilters = Boolean(group.showFilters);

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
      catalogues,
      showFilters,
    };
  }

  // Head office (or a single-site customer with no branch split at all):
  // every code in the group, resolved live from what the sync job cached.
  let customerCodes = (await getJSON<string[]>(`group:${group.groupKey}:codes`)) ?? [];

  // Aggregate orgs (Hayward) fall back to the full account list when
  // group:Hayward:codes hasn't been populated yet — e.g. sync hasn't run since
  // the Hayward group was added.
  //
  // Reads customerNames, not codeToGroup. codeToGroup only holds codes that
  // belong to a configured group, so the old fallback capped Hayward staff at
  // the configured accounts — the same blind spot that hid the au-orders
  // customers. customerNames is every account in DRSMAST.
  if (customerCodes.length === 0 && group.isAggregate) {
    const names = await getJSON<Record<string, string>>('customerNames');
    if (names) customerCodes = Object.keys(names);
  }
  return {
    groupName: group.displayName,
    groupKey: group.groupKey,
    isHeadOffice: true,
    isAggregate: Boolean(group.isAggregate),
    branchCode: null,
    customerCodes,
    catalogues,
    showFilters,
  };
}

// ---------------------------------------------------------------------------
// Stock scope — the single enforcement point
// ---------------------------------------------------------------------------
// Every surface that reads stock (products page + /api/products, warehouse,
// forecast, pricing, the in-portal assistant) goes through this instead of
// hardcoding 'stock:all'. The requested view arrives from the query string and
// is therefore untrusted: it selects WITHIN what the org holds and can never
// widen it. `keys` is always intersected against access.catalogues last, so a
// hand-built CustomerAccess can't widen scope either.

export interface StockScope {
  /** The view actually applied, after clamping to what the org holds. */
  view: StockView;
  /** Namespaces being read for this view. */
  catalogues: Catalogue[];
  /** Consolidated-list keys to read, in display order (Hayward first). */
  keys: string[];
  /** Buttons the UI should render. Empty when the org gets no filter row. */
  availableViews: StockView[];
  /** True when this response can contain Paramount SKUs. */
  includesParamount: boolean;
}

/** The fields of a cached stock entry the view filters actually read. */
export interface StockEntryLike {
  stockCategory?: string | null;
  supplierCode?: string | null;
}

function isParamountCategory(cat: string | null | undefined): boolean {
  return (cat ?? '').trim().toUpperCase() === PARAMOUNT_CATEGORY;
}

// Paramount takes precedence over Flow Control when a SKU somehow satisfies
// both, so the three views stay disjoint and no SKU appears under two buttons.
// diagnose-flowcontrol.js reports whether any such overlap actually exists.
function isFlowControlSupplier(entry: StockEntryLike): boolean {
  if (isParamountCategory(entry.stockCategory)) return false;
  return FLOW_CONTROL_SUPPLIER_CODES.has((entry.supplierCode ?? '').trim());
}

// Buttons are derived strictly from held catalogues, so an org can never be
// shown a filter for stock it isn't permitted. Compass and Poolwater Products
// get three buttons; Hayward staff get four.
export function availableViewsFor(access: CustomerAccess): StockView[] {
  if (!access.showFilters) return [];
  const views: StockView[] = ['all', 'hayward'];
  if (access.catalogues.includes('paramount')) views.push('paramount');
  if (access.catalogues.includes('flowcontrol')) views.push('flowcontrol');
  return views;
}

export function resolveStockScope(
  access: CustomerAccess,
  requestedView?: StockView | null
): StockScope {
  const availableViews = availableViewsFor(access);

  // Default is everything the org holds, merged. Clamp anything unrecognised,
  // unavailable, or simply absent back to 'all'.
  let view: StockView =
    requestedView && availableViews.includes(requestedView) ? requestedView : 'all';

  // Belt and braces — a narrow view is only reachable if the org holds the
  // matching catalogue. Anything else falls back to the merged view, which is
  // itself scoped to what the org holds.
  if (view !== 'all' && !access.catalogues.includes(view as Catalogue)) view = 'all';

  // Each narrow view now maps 1:1 onto its own namespace, so a view reads only
  // the key it needs: the Paramount view never pulls stock:all, and the
  // Hayward view never pulls fc:stock:all.
  const catalogues: Catalogue[] =
    view === 'all' ? access.catalogues : [view as Catalogue];

  // Final intersection against the permission boundary. Nothing past this line
  // can return a key the org does not hold.
  const allowed = CATALOGUE_ORDER.filter(
    (c) => catalogues.includes(c) && access.catalogues.includes(c)
  );

  return {
    view,
    catalogues: allowed,
    keys: allowed.map((c) => STOCK_ALL_KEY[c]),
    availableViews,
    includesParamount: allowed.includes('paramount'),
  };
}

/**
 * Secondary predicate, applied after the keys are read.
 *
 * Since each catalogue is now its own namespace, this is defence in depth
 * rather than the mechanism — the isolation is that an org is never handed a
 * pr: or fc: key at all. This catches the case where a sync exclusion is
 * dropped and PR or 17300 stock reappears inside stock:all: those SKUs would
 * still be filtered out of the Hayward view rather than silently shown.
 *
 *   all         -> everything the org holds
 *   hayward     -> not Paramount, not Flow Control
 *   paramount   -> STOCK_CATEGORY 'PR'
 *   flowcontrol -> SUPPLIER_CODE 17300
 */
export function stockViewFilter(
  scope: StockScope
): (entry: StockEntryLike) => boolean {
  switch (scope.view) {
    case 'paramount':
      return (e) => isParamountCategory(e.stockCategory);
    case 'flowcontrol':
      return (e) => isFlowControlSupplier(e);
    case 'hayward':
      return (e) => !isParamountCategory(e.stockCategory) && !isFlowControlSupplier(e);
    case 'all':
    default:
      return () => true;
  }
}

/** Parses the `view` query param. Unknown or absent -> null (org default). */
export function parseStockView(searchParams: URLSearchParams): StockView | null {
  const raw = (searchParams.get('view') ?? '').toLowerCase();
  const known: StockView[] = ['all', 'hayward', 'paramount', 'flowcontrol'];
  return (known as string[]).includes(raw) ? (raw as StockView) : null;
}

/** Human labels for the filter buttons. */
export const STOCK_VIEW_LABEL: Record<StockView, string> = {
  all: 'All SKUs',
  hayward: 'Hayward SKUs',
  paramount: 'Paramount SKUs',
  flowcontrol: 'Flow Control SKUs',
};

/**
 * Per-SKU key candidates for a single lookup (product modal, assistant).
 * Only returns keys in catalogues the caller holds, so a distributor can
 * never probe pr:stock:{sku} by guessing a Paramount part number.
 */
export function stockKeysForSku(access: CustomerAccess, sku: string): string[] {
  return access.catalogues.map((c) => `${STOCK_KEY_PREFIX[c]}${sku}`);
}

/** Direct permission check, for surfaces that don't need a full scope. */
export function canSeeCatalogue(access: CustomerAccess, catalogue: Catalogue): boolean {
  return access.catalogues.includes(catalogue);
}

// Groups whose Arrow master AUTO_PRICE_TYPE is unreliable or inconsistent
// across branches, mapped to the one tier the whole group is priced at.
//
// Exported because /api/customers needs the same map to decide whether a
// group's pricing is settled. Without it the picker reads raw AUTO_PRICE_TYPE,
// sees branches disagreeing, and flags a group whose price is in fact fixed.
export const GROUP_PRICE_TYPE_OVERRIDE: Record<string, string> = {
  // Set 22 Jul 2026. Supersedes an earlier D5 override that cited Arrow
  // pro-formas; neither D5 nor AK reproduced Poolwerx's actual billed prices
  // (both compute roughly half what Arrow charged), so that question was
  // closed on business direction rather than on the billing data. If Poolwerx
  // pricing is ever queried, the open item is which STKMAST price column the
  // discount applies to — see sql/verify-poolwerx-pricetype.sql.
  Poolwerx: 'AK',

  Reece: 'RE',
  PoolSpaWarehouse: 'A5',

  // Master is D5 on 714005 and ZC/blank on 700957 and 718223. ZC is a closed
  // placeholder, never a real tier, so D5 is the whole group's price.
  Legend: 'D5',
};

// A price type is only usable if it exists and isn't a closed/placeholder "Z..."
// code (ZC, ZCLOSE, blank) - those never have a pricing:{type} rule set.
export function isUsablePriceType(t: string | null | undefined): t is string {
  return !!t && !t.startsWith('Z');
}

/**
 * Resolves which price type a pricing request should use:
 *   1. an explicit per-group override (for groups with known-bad master data),
 *   2. the representative customer's own price type, if usable,
 *   3. otherwise the first sibling in the same group with a usable price type.
 * `requestedCode` is the staff-selected customer from the picker; it's honored
 * only when it's within the caller's allowed customerCodes.
 *
 * KNOWN GAP FOR PARAMOUNT: diagnose-paramount.js found ZERO SPRTRAN rules on
 * STOCK_CATEGORY 'PR' anywhere in Arrow, so no price type has Paramount
 * pricing. PR SKUs will render without a price for every org, including staff,
 * until those rules are set up in Arrow. That is a data task, not a code fix.
 */
export async function resolvePriceType(
  access: CustomerAccess,
  requestedCode?: string | null
): Promise<{ representativeCode: string | null; priceType: string | null }> {
  const representativeCode =
    requestedCode && access.customerCodes.includes(requestedCode)
      ? requestedCode
      : access.branchCode ?? access.customerCodes[0] ?? null;

  if (!representativeCode) return { representativeCode: null, priceType: null };

  // Resolve the group that actually OWNS this code (for staff viewing a
  // specific customer, that's the customer's group, not "Hayward").
  const codeToGroup = await getJSON<Record<string, string>>('codeToGroup');
  const groupKey = codeToGroup?.[representativeCode] ?? access.groupKey;

  // 1. Explicit override wins (Arrow-matched tier for unreliable master data).
  const override = GROUP_PRICE_TYPE_OVERRIDE[groupKey];
  if (override) return { representativeCode, priceType: override };

  // 2. The customer's own price type, if usable.
  const own = await redis.get<string>(`customerPriceType:${representativeCode}`);
  if (isUsablePriceType(own)) return { representativeCode, priceType: own };

  // 3. Fall back to a group sibling with a usable price type
  //    (e.g. Legend 700957/718223 are ZC/blank but 714005 is D5).
  if (codeToGroup) {
    const sibs = Object.keys(codeToGroup)
      .filter((c) => codeToGroup[c] === groupKey && c !== representativeCode)
      .slice(0, 50);
    const types = await Promise.all(
      sibs.map((c) => redis.get<string>(`customerPriceType:${c}`))
    );
    for (const t of types) {
      if (isUsablePriceType(t)) return { representativeCode, priceType: t };
    }
  }

  return { representativeCode, priceType: null };
}
