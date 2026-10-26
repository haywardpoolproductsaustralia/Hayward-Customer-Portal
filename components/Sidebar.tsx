'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { OrganizationSwitcher } from '@clerk/nextjs';
// Inbox, TrendingUp and Hourglass are intentionally not imported while their
// nav items are commented out below - re-add them when restoring those pages.
import { Boxes, Receipt, Tag, BookOpen, Menu, X, Home, Sparkles, Warehouse, UserSearch, ShieldCheck, GitCompareArrows, ShoppingCart, Container } from 'lucide-react';
import { PORTAL_ORDERS_ENABLED } from '@/lib/features';
import { isPageHidden, isFeatureHidden } from '@/lib/page-visibility';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Home', icon: Home },
  // The ordering entry point sits directly under Home. Same route as the old
  // "Pricing" item, so bookmarks and page-visibility rules are unaffected.
  // Groups that opted out of ordering get it relabelled back to "Pricing"
  // in NavLinks below.
  ...(PORTAL_ORDERS_ENABLED
    ? [{ href: '/dashboard/pricing', label: 'Place an order', icon: ShoppingCart }]
    : []),
  { href: '/dashboard/products', label: 'Products', icon: Boxes },
  { href: '/dashboard/orders', label: 'Orders', icon: Receipt },
  ...(PORTAL_ORDERS_ENABLED ? [] : [{ href: '/dashboard/pricing', label: 'Pricing', icon: Tag }]),
  { href: '/dashboard/manuals', label: 'Manuals', icon: BookOpen },
  { href: '/dashboard/warranty', label: 'Warranty', icon: ShieldCheck },
];

const STAFF_ONLY_NAV_ITEMS = [
  // Portal orders is hidden while PORTAL_ORDERS_ENABLED is false. Kept in the
  // list rather than deleted so re-enabling is one flag, not an edit here.
  ...(PORTAL_ORDERS_ENABLED
    ? [{ href: '/dashboard/portal-orders', label: 'Portal orders', icon: ShoppingCart }]
    : []),
  // AU-orders inbox, Forecast and Slow stock hidden from the sidebar, Oct 2026.
  // The pages and their API routes still exist and are reachable by URL for
  // staff; uncomment a line to put it back in the nav.
  // { href: '/dashboard/au-orders-inbox', label: 'AU-orders inbox', icon: Inbox },
  { href: '/dashboard/lookup', label: 'Customers', icon: UserSearch },
  { href: '/dashboard/warehouse', label: 'Warehouse', icon: Warehouse },
  // Direct container orders: SO -> Wuxi/US PO -> container + ETA. Staff only
  // for now (Oct 2026); the API route enforces isAggregate too.
  { href: '/dashboard/container-orders', label: 'Container orders', icon: Container },
  // { href: '/dashboard/forecast', label: 'Forecast', icon: TrendingUp },
  // { href: '/dashboard/slow-stock', label: 'Slow stock', icon: Hourglass },
];

// Reconciliation access: Hayward staff + approved customers (Poolwater Products)
const RECONCILIATION_NAV_ITEM = { href: '/dashboard/reconciliation', label: 'Purchasing', icon: GitCompareArrows };


function NavLinks({
  pathname,
  isAggregate,
  groupKey,
  onNavigate,
}: {
  pathname: string;
  isAggregate: boolean;
  groupKey?: string | null;
  onNavigate?: () => void;
}) {
  const staffItems = [...NAV_ITEMS, ...STAFF_ONLY_NAV_ITEMS];
  const canAccessReconciliation = isAggregate || groupKey === 'PoolwaterProducts';
  const base = isAggregate
    ? [...staffItems, ...(canAccessReconciliation ? [RECONCILIATION_NAV_ITEM] : [])]
    : [...NAV_ITEMS, ...(canAccessReconciliation ? [RECONCILIATION_NAV_ITEM] : [])];

  // Per-group hiding (lib/page-visibility.ts). This only removes the LINK -
  // the page and its API route enforce the same rule server-side, since a
  // hidden link is still a reachable URL.
  const orderingHidden = isFeatureHidden('ordering', groupKey, isAggregate);
  const items = base
    .filter((item) => !isPageHidden(item.href, groupKey, isAggregate))
    .map((item) =>
      orderingHidden && item.href === '/dashboard/pricing'
        ? { ...item, label: 'Pricing', icon: Tag }
        : item
    );

  return (
    <nav className="flex flex-col gap-1">
      {items.map((item) => {
        const Icon = item.icon;
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
              active ? 'bg-wave/10 text-wave' : 'text-ink/60 hover:bg-ink/5 hover:text-ink'
            }`}
          >
            <Icon className="h-5 w-5" strokeWidth={active ? 2.5 : 2} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

// isAggregate gates the staff-only nav items (Customers, Warehouse, and any
// others in STAFF_ONLY_NAV_ITEMS) - these only show for the Hayward aggregate org.
// app/dashboard/layout.tsx passes it through, and other components
// (CustomerPicker) key off it too.
//
// groupKey is the customer-group key from lib/access.ts, passed through for
// per-group page hiding (e.g. Reece doesn't get Warranty). It's separate from
// isAggregate on purpose: Hayward's org contains every group's codes, so any
// code-based test would hide staff pages too.
//
// Mobile: this component no longer renders its own top bar. It renders an
// inline hamburger + logo that app/dashboard/layout.tsx places at the left of
// the single sticky header, so phones get one bar instead of two stacked ones.
// The desktop <aside> and the drawer are position:fixed, so where this sits in
// the DOM doesn't affect them.
export function SidebarNav({
  isAggregate = false,
  groupKey = null,
}: {
  isAggregate?: boolean;
  groupKey?: string | null;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close the drawer on route change (e.g. browser back) and lock body scroll
  // while it's open so the page behind doesn't scroll on touch devices.
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      {/* Mobile: hamburger + logo, inline in the dashboard header */}
      <div className="lg:hidden flex items-center gap-1 min-w-0">
        <button
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          aria-expanded={open}
          className="-ml-2 p-2 rounded-lg text-ink/60 hover:bg-ink/5 active:bg-ink/10"
        >
          <Menu className="h-5 w-5" />
        </button>
        <Link href="/dashboard" className="flex items-center">
          <Image src="/hayward-logo.png" alt="Hayward" width={105} height={24} className="h-6 w-auto" priority />
        </Link>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div
            className="w-[min(18rem,85vw)] bg-white flex flex-col shadow-soft"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-ink/10">
              <Image src="/hayward-logo.png" alt="Hayward" width={105} height={24} className="h-6 w-auto" />
              <button onClick={() => setOpen(false)} aria-label="Close menu" className="p-2 -mr-2 rounded-lg text-ink/60 hover:bg-ink/5">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <NavLinks
                pathname={pathname}
                isAggregate={isAggregate}
                groupKey={groupKey}
                onNavigate={() => setOpen(false)}
              />
            </div>
            <div className="border-t border-ink/10 px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-ink/40 mb-1.5">Organisation</p>
              <OrganizationSwitcher
                hidePersonal
                afterSelectOrganizationUrl="/dashboard"
                appearance={{ elements: { rootBox: 'flex w-full', organizationSwitcherTrigger: 'py-1.5 px-2 rounded-lg w-full justify-between' } }}
              />
            </div>
          </div>
          <button
            type="button"
            aria-label="Close menu"
            className="flex-1 bg-ink/40 cursor-default"
            onClick={() => setOpen(false)}
          />
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden lg:flex lg:flex-col lg:w-60 lg:fixed lg:inset-y-0 bg-white border-r border-ink/10 px-4 py-6 z-30">
        <div className="px-2 mb-8">
          <Image src="/hayward-logo.png" alt="Hayward" width={140} height={32} className="h-8 w-auto" priority />
        </div>
        <NavLinks pathname={pathname} isAggregate={isAggregate} groupKey={groupKey} />
      </aside>
    </>
  );
}
