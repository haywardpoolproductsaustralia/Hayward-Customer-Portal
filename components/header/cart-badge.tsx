'use client';

import { useCart } from '@/lib/cart-store';
import Link from 'next/link';
import { ShoppingCart } from 'lucide-react';

export function CartBadge() {
  const lineCount = useCart(state => state.getLineCount());
  
  if (lineCount === 0) return null;
  
  return (
    <Link
      href="/dashboard/checkout"
      className="relative flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 text-amber-700 hover:bg-amber-100 transition"
    >
      <ShoppingCart size={20} />
      <span className="font-medium">{lineCount} items</span>
      <span className="absolute -top-2 -right-2 bg-coral text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
        {lineCount}
      </span>
    </Link>
  );
}
