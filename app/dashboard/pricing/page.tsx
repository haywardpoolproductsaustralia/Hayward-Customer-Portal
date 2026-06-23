'use client';

import { useState } from 'react';
import { Tag, Loader2 } from 'lucide-react';

interface PriceResult {
  sku: string;
  qty: number;
  priceType: string;
  listPrice: number | null;
  price: number | null;
  discountPercent: number | null;
}

function formatMoney(value: number | null) {
  if (value == null) return '-';
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(value);
}

export default function PricingPage() {
  const [sku, setSku] = useState('');
  const [qty, setQty] = useState('1');
  const [result, setResult] = useState<PriceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    const trimmedSku = sku.trim();
    if (!trimmedSku) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch(
        `/api/pricing?sku=${encodeURIComponent(trimmedSku)}&qty=${encodeURIComponent(qty || '1')}`
      );
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'Something went wrong looking that up.');
      else setResult(data);
    } catch {
      setError('Could not reach pricing right now. Try again in a moment.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl text-deep font-bold">Pricing</h1>
        <p className="text-ink/50 mt-1">Get an exact price for any SKU and quantity.</p>
      </div>

      <form onSubmit={search} className="rounded-2xl bg-white border border-ink/10 shadow-soft p-5 flex flex-wrap gap-3 items-end max-w-xl">
        <div className="flex-1 min-w-[180px]">
          <label className="block text-xs font-medium text-ink/40 mb-1.5">SKU</label>
          <input
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder="e.g. 1A-AV250LI"
            className="w-full rounded-xl border border-ink/10 px-3.5 py-2.5 text-sm focus:border-wave focus:ring-2 focus:ring-wave/20 outline-none"
          />
        </div>
        <div className="w-24">
          <label className="block text-xs font-medium text-ink/40 mb-1.5">Qty</label>
          <input
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            type="number"
            min="1"
            className="w-full rounded-xl border border-ink/10 px-3.5 py-2.5 text-sm focus:border-wave focus:ring-2 focus:ring-wave/20 outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="rounded-xl bg-wave px-5 py-2.5 text-sm font-semibold text-white shadow-glow hover:bg-deep transition-colors disabled:opacity-50 flex items-center gap-2"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Tag className="h-4 w-4" />}
          {loading ? 'Checking...' : 'Get price'}
        </button>
      </form>

      {error && <p className="text-sm text-coral">{error}</p>}

      {result && (
        <div className="rounded-2xl bg-white border border-ink/10 shadow-soft p-7 max-w-md space-y-3">
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-sm text-ink/50">{result.sku}</span>
            <span className="text-xs text-ink/40">qty {result.qty}</span>
          </div>
          <div className="flex items-baseline gap-3">
            <span className="font-display text-4xl text-deep font-bold">{formatMoney(result.price)}</span>
            {result.listPrice != null && result.price !== result.listPrice && (
              <span className="text-sm text-ink/40 line-through">{formatMoney(result.listPrice)}</span>
            )}
          </div>
          {result.discountPercent != null && (
            <p className="text-sm text-sunset font-semibold">{result.discountPercent}% off list</p>
          )}
          <p className="text-xs text-ink/40">Ex GST</p>
        </div>
      )}
    </div>
  );
}
