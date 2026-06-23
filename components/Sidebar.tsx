'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Boxes, Receipt, Tag, BookOpen, Menu, X, Droplets, Home } from 'lucide-react';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Home', icon: Home },
  { href: '/dashboard/products', label: 'Products', icon: Boxes },
  { href: '/dashboard/orders', label: 'Orders', icon: Receipt },
  { href: '/dashboard/pricing', label: 'Pricing', icon: Tag },
  { href: '/dashboard/manuals', label: 'Manuals', icon: BookOpen },
];

function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-1">
      {NAV_ITEMS.map((item) => {
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

export function SidebarNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Mobile top bar */}
      <div className="lg:hidden flex items-center justify-between px-4 py-3 bg-white border-b border-ink/10 sticky top-0 z-40">
        <div className="flex items-center gap-2">
          <Droplets className="h-5 w-5 text-wave" strokeWidth={2.5} />
          <span className="font-display text-lg text-deep font-bold">Hayward</span>
        </div>
        <button onClick={() => setOpen(true)} aria-label="Open menu" className="p-2">
          <Menu className="h-5 w-5 text-ink/60" />
        </button>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div className="w-72 bg-white p-4 flex flex-col gap-1 shadow-soft">
            <div className="flex items-center justify-between mb-4 px-2">
              <span className="font-display text-lg text-deep font-bold">Hayward</span>
              <button onClick={() => setOpen(false)} aria-label="Close menu" className="p-2">
                <X className="h-5 w-5 text-ink/60" />
              </button>
            </div>
            <NavLinks pathname={pathname} onNavigate={() => setOpen(false)} />
          </div>
          <div className="flex-1 bg-ink/40" onClick={() => setOpen(false)} />
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden lg:flex lg:flex-col lg:w-60 lg:fixed lg:inset-y-0 bg-white border-r border-ink/10 px-4 py-6 z-30">
        <div className="flex items-center gap-2 px-2 mb-8">
          <Droplets className="h-6 w-6 text-wave" strokeWidth={2.5} />
          <span className="font-display text-xl text-deep font-bold">Hayward</span>
        </div>
        <NavLinks pathname={pathname} />
      </aside>
    </>
  );
}
