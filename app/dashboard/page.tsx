import Link from 'next/link';
import { Boxes, Receipt, Tag, MapPin, ArrowRight } from 'lucide-react';
import { getCustomerAccess } from '@/lib/access';
import { getJSON } from '@/lib/redis';

interface StockEntry {
  sku: string;
}

interface OrderLine {
  statusFlag: string;
}

export default async function DashboardHome() {
  const access = await getCustomerAccess();

  if (!access) {
    return (
      <p className="text-ink/60">
        Choose an organization from the switcher above to get started.
      </p>
    );
  }

  const [allStock, ...orderLists] = await Promise.all([
    getJSON<StockEntry[]>('stock:all'),
    ...access.customerCodes.map((code) => getJSON<OrderLine[]>(`orders:${code}`)),
  ]);

  const totalSkus = allStock?.length ?? 0;
  const allOrders = orderLists.flat().filter(Boolean) as OrderLine[];
  const openOrders = allOrders.filter((o) => o.statusFlag === 'A' || o.statusFlag === 'B').length;

  const stats = [
    { label: 'Locations', value: access.customerCodes.length, icon: MapPin },
    { label: 'Open orders', value: openOrders, icon: Receipt },
    { label: 'Products available', value: totalSkus.toLocaleString(), icon: Boxes },
  ];

  const quickLinks = [
    { href: '/dashboard/products', label: 'Browse products', desc: 'Search stock and pricing', icon: Boxes },
    { href: '/dashboard/orders', label: 'Check your orders', desc: 'Status on every order', icon: Receipt },
    { href: '/dashboard/pricing', label: 'Get a quote', desc: 'Price by SKU and quantity', icon: Tag },
  ];

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm font-medium text-wave mb-1">Welcome back</p>
        <h1 className="font-display text-3xl text-deep font-bold">
          {access.groupName}
          {access.branchCode ? '' : ' \u00b7 Head office'}
        </h1>
        <p className="text-ink/50 mt-1">
          {access.isHeadOffice
            ? `You're viewing all ${access.customerCodes.length} location(s).`
            : 'Viewing your location.'}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <div key={s.label} className="rounded-2xl bg-white border border-ink/10 shadow-soft p-5">
              <div className="flex items-center gap-2 text-ink/40 mb-2">
                <Icon className="h-4 w-4" />
                <span className="text-xs font-medium uppercase tracking-wide">{s.label}</span>
              </div>
              <p className="font-display text-3xl text-deep font-bold">{s.value}</p>
            </div>
          );
        })}
      </div>

      <div>
        <h2 className="text-sm font-semibold text-ink/40 uppercase tracking-wide mb-3">
          Quick links
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {quickLinks.map((q) => {
            const Icon = q.icon;
            return (
              <Link
                key={q.href}
                href={q.href}
                className="group rounded-2xl bg-white border border-ink/10 shadow-soft p-5 hover:border-wave/30 hover:shadow-glow transition-all"
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="rounded-xl bg-wave/10 p-2.5">
                    <Icon className="h-5 w-5 text-wave" />
                  </div>
                  <ArrowRight className="h-4 w-4 text-ink/20 group-hover:text-wave group-hover:translate-x-0.5 transition-all" />
                </div>
                <p className="font-semibold text-ink">{q.label}</p>
                <p className="text-sm text-ink/50">{q.desc}</p>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
