'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { Boxes, Receipt, Tag, BookOpen, Menu, X, Home, Sparkles, Warehouse, TrendingUp, Inbox, UserSearch, ShieldCheck, GitCompareArrows } from 'lucide-react';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Home', icon: Home },
  { href: '/dashboard/products', label: 'Products', icon: Boxes },
  { href: '/dashboard/orders', label: 'Orders', icon: Receipt },
  { href: '/dashboard/pricing', label: 'Pricing', icon: Tag },
  { href: '/dashboard/manuals', label: 'Manuals', icon: BookOpen },
  { href: '/dashboard/support', label: 'Warranty', icon: ShieldCheck },
  ];

const STAFF_ONLY_NAV_ITEMS = [
  { href: '/dashboard/au-orders-inbox', label: 'AU-orders inbox', icon: Inbox },
  { href: '/dashboard/lookup', label: 'Customers', icon: UserSearch },
  { href: '/dashboard/warehouse', label: 'Warehouse', icon: Warehouse },
  { href: '/dashboard/forecast', label: 'Forecast', icon: TrendingUp },
  { href: '/dashboard/reconciliation', label: 'Reconciliation', icon: GitCompareArrows },
];


function NavLinks({
  pathname,
  isAggregate,
  onNavigate,
}: {
  pathname: string;
  isAggregate: boolean;
  onNavigate?: () => void;
}) {
  const items = isAggregate ? [...NAV_ITEMS, ...STAFF_ONLY_NAV_ITEMS] : NAV_ITEMS;
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

// isAggregate gates the staff-only nav items (au-orders inbox, Lookup,
// Warehouse, Forecast) - these only show for the Hayward aggregate org.
// app/dashboard/layout.tsx passes it through, and other components
// (CustomerPicker) key off it too.
export function SidebarNav({ isAggregate = false }: { isAggregate?: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Mobile top bar */}
      <div className="lg:hidden flex items-center justify-between px-4 py-3 bg-white border-b border-ink/10 sticky top-0 z-40">
        <Image src="/hayward-logo.png" alt="Hayward" width={105} height={24} className="h-6 w-auto" priority />
        <button onClick={() => setOpen(true)} aria-label="Open menu" className="p-2">
          <Menu className="h-5 w-5 text-ink/60" />
        </button>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div className="w-72 bg-white p-4 flex flex-col gap-1 shadow-soft">
            <div className="flex items-center justify-between mb-4 px-2">
              <Image src="/hayward-logo.png" alt="Hayward" width={105} height={24} className="h-6 w-auto" />
              <button onClick={() => setOpen(false)} aria-label="Close menu" className="p-2">
                <X className="h-5 w-5 text-ink/60" />
              </button>
            </div>
            <NavLinks pathname={pathname} isAggregate={isAggregate} onNavigate={() => setOpen(false)} />
          </div>
          <div className="flex-1 bg-ink/40" onClick={() => setOpen(false)} />
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden lg:flex lg:flex-col lg:w-60 lg:fixed lg:inset-y-0 bg-white border-r border-ink/10 px-4 py-6 z-30">
        <div className="px-2 mb-8">
          <Image src="/hayward-logo.png" alt="Hayward" width={140} height={32} className="h-8 w-auto" priority />
        </div>
        <NavLinks pathname={pathname} isAggregate={isAggregate} />
      </aside>
    </>
  );
}
