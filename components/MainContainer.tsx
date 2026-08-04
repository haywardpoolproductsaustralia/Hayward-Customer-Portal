'use client';

import { usePathname } from 'next/navigation';

/**
 * Routes that render edge-to-edge instead of being capped at max-w-6xl.
 * These are the wide-table pages where the 1152px cap wastes screen space.
 * To widen another page, just add its path here.
 */
const FULL_WIDTH_ROUTES = [
  '/dashboard/orders',
];

export function MainContainer({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '';

  const fullWidth = FULL_WIDTH_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );

  return (
    <main className={`px-4 sm:px-8 py-8 ${fullWidth ? 'w-full' : 'max-w-6xl'}`}>
      {children}
    </main>
  );
}
