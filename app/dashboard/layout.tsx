import { OrganizationSwitcher, UserButton } from '@clerk/nextjs';
import { Sparkles } from 'lucide-react';
import { getCustomerAccess } from '@/lib/access';
import { getJSON } from '@/lib/redis';
import { SidebarNav } from '@/components/Sidebar';

interface SyncMeta {
  lastRunAt: string;
  lastRunStatus: string;
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const access = await getCustomerAccess();
  const meta = await getJSON<SyncMeta>('sync:meta');

  const lastUpdated = meta?.lastRunAt
    ? new Date(meta.lastRunAt).toLocaleString('en-AU', {
        dateStyle: 'short',
        timeStyle: 'short',
        timeZone: 'Australia/Melbourne',
      })
    : 'unknown';

  return (
    <div className="min-h-screen bg-foam">
      <SidebarNav />

      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 bg-white/80 backdrop-blur border-b border-ink/10">
          <div className="px-4 sm:px-8 py-3 flex items-center justify-between gap-4">
            <OrganizationSwitcher
              hidePersonal
              afterSelectOrganizationUrl="/dashboard"
              appearance={{ elements: { rootBox: 'flex', organizationSwitcherTrigger: 'py-1.5 px-2 rounded-lg' } }}
            />
            <div className="flex items-center gap-4">
              <span className="hidden sm:flex items-center gap-1.5 text-xs text-ink/40">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-splash opacity-75 animate-ping" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-splash" />
                </span>
                Updated {lastUpdated}
              </span>
              <UserButton afterSignOutUrl="/" />
            </div>
          </div>
        </header>

        {!access && (
          <div className="px-4 sm:px-8 pt-6">
            <div className="rounded-2xl bg-white border border-amber/20 shadow-soft px-5 py-4 flex items-center gap-3">
              <Sparkles className="h-5 w-5 text-amber flex-shrink-0" />
              <p className="text-sm text-ink/70">
                Select an organization from the switcher above to see your stock, orders, and pricing.
              </p>
            </div>
          </div>
        )}

        <main className="px-4 sm:px-8 py-8 max-w-6xl">{children}</main>
      </div>
    </div>
  );
}
