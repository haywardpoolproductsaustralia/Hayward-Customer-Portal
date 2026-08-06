// app/dashboard/catalog/page.tsx
// -------------------------------------------------------------------------
// Product catalog page for the Hayward B2B portal. Client component that
// reads /api/products (Redis-backed) and renders a searchable, category-
// filtered grid with a detail modal. Styling uses your existing Tailwind
// design tokens (wave / deep / foam / splash / amber / ink).
//
// Add to nav in components/Sidebar.tsx (this one is customer-visible, so it
// goes in the normal nav list, NOT STAFF_ONLY_NAV_ITEMS):
//   { href: '/dashboard/catalog', label: 'Product Catalog', icon: <Grid/> }
// -------------------------------------------------------------------------
'use client';

import { useEffect, useMemo, useState } from 'react';

type Stock = { onHand: number; byLocation: Record<string, any>; updatedAt?: string } | null;
type Product = {
  sku: string;
  name: string;
  image: string | null;
  description: string | null;
  specs: Record<string, string>;
  category: string;
  stock: Stock;
};

export default function CatalogPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [cat, setCat] = useState('All');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/products')
      .then((r) => r.json())
      .then((d) => {
        setProducts(d.products || []);
        setCategories(['All', ...(d.categories || [])]);
      })
      .finally(() => setLoading(false));
  }, []);

  const list = useMemo(() => {
    const query = q.trim().toLowerCase();
    return products.filter((p) => {
      const catOk = cat === 'All' || p.category === cat;
      const qOk = !query || p.name.toLowerCase().includes(query) || p.sku.toLowerCase().includes(query);
      return catOk && qOk;
    });
  }, [products, cat, q]);

  function stockBadge(s: Stock) {
    const n = s?.onHand ?? null;
    if (n === null) return <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">Stock —</span>;
    if (n === 0) return <span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">On backorder</span>;
    if (n < 10) return <span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">Low · {n}</span>;
    return <span className="rounded bg-green-100 px-2 py-0.5 text-[11px] font-semibold text-green-800">In stock · {n}</span>;
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-3 py-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-ink">Product Catalog</h1>
        <p className="text-sm text-slate-500">Browse the full Hayward range with live stock for your account.</p>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name or SKU…"
            className="w-full rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-wave"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={`rounded-full border px-3.5 py-2 text-[13px] font-semibold ${
                c === cat ? 'border-wave bg-wave text-white' : 'border-slate-200 bg-white text-slate-500'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="py-20 text-center text-slate-400">Loading catalog…</div>
      ) : (
        <>
          <div className="mb-3 text-[13px] text-slate-500">
            {list.length} product{list.length !== 1 ? 's' : ''}
            {cat !== 'All' ? ` in ${cat}` : ''}
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
            {list.map((p) => (
              <button
                key={p.sku}
                onClick={() => setSel(p)}
                className="group flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white text-left transition hover:-translate-y-0.5 hover:border-sky-200 hover:shadow-lg"
              >
                <div className="flex aspect-square items-center justify-center bg-foam p-4">
                  {p.image && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.image} alt={p.name} loading="lazy" className="max-h-full max-w-full object-contain mix-blend-multiply" />
                  )}
                </div>
                <div className="p-3">
                  <div className="min-h-[36px] text-sm font-bold leading-tight text-ink">{p.name}</div>
                  <div className="mt-1 font-mono text-[12px] text-slate-500">{p.sku}</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {p.specs['Total HP'] && <span className="rounded bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-deep">{p.specs['Total HP']}</span>}
                    {stockBadge(p.stock)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {sel && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 p-5"
          onClick={(e) => e.target === e.currentTarget && setSel(null)}
        >
          <div className="grid max-h-[90vh] w-full max-w-3xl grid-cols-1 overflow-auto rounded-2xl bg-white sm:grid-cols-2">
            <div className="flex items-center justify-center bg-foam p-7">
              {sel.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={sel.image} alt={sel.name} className="max-h-[360px] max-w-full object-contain mix-blend-multiply" />
              )}
            </div>
            <div className="p-6">
              <h2 className="text-xl font-bold text-ink">{sel.name}</h2>
              <div className="font-mono text-[13px] text-slate-500">{sel.sku} · {sel.category}</div>
              <p className="my-4 text-sm leading-relaxed text-slate-700">{sel.description}</p>
              <table className="w-full border-collapse text-[13px]">
                <tbody>
                  {Object.entries(sel.specs).map(([k, v]) => (
                    <tr key={k} className="border-b border-slate-100">
                      <td className="py-1.5 text-slate-500">{k}</td>
                      <td className="py-1.5 text-right font-semibold">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {sel.stock?.byLocation && (
                <div className="mt-4 rounded-lg bg-foam p-3 text-[12.5px] text-deep">
                  <div className="mb-1 font-semibold">Live stock by location</div>
                  {Object.entries(sel.stock.byLocation).map(([loc, v]: any) => (
                    <div key={loc} className="flex justify-between">
                      <span>{loc}</span>
                      <span className="font-semibold">{v.onHand}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
