'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, Plus } from 'lucide-react';

export interface ProductOption {
  sku: string;
  name?: string | null;
  supplierStock?: string | null;
  stockCategory?: string | null;
}

interface Props<T extends ProductOption> {
  options: T[];
  onSelect: (option: T) => void;
  // 'sku' matches on SKU + supplier code and shows the code first;
  // 'description' matches on the product name and shows the name first.
  mode: 'sku' | 'description';
  placeholder?: string;
  disabled?: boolean;
  excludeSkus?: Set<string>;
}

export function ProductCombobox<T extends ProductOption>({
  options,
  onSelect,
  mode,
  placeholder,
  disabled,
  excludeSkus,
}: Props<T>) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const trimmed = query.trim().toUpperCase();
  const results = trimmed
    ? options
        .filter((o) => !excludeSkus?.has(o.sku))
        .filter((o) =>
          mode === 'sku'
            ? o.sku.toUpperCase().includes(trimmed) ||
              (o.supplierStock ?? '').toUpperCase().includes(trimmed)
            : (o.name ?? '').toUpperCase().includes(trimmed)
        )
        .slice(0, 8)
    : [];

  // Reset the keyboard highlight whenever the query changes.
  useEffect(() => {
    setHighlight(0);
  }, [query]);

  // Close the dropdown when clicking anywhere outside this combobox.
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  function choose(option: T) {
    onSelect(option);
    setQuery('');
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const picked = results[highlight];
      if (picked) choose(picked);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-ink/30 pointer-events-none" />
      <input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full rounded-full border border-ink/10 bg-white pl-11 pr-4 py-3 text-sm shadow-soft focus:border-wave focus:ring-2 focus:ring-wave/20 outline-none disabled:opacity-50"
      />

      {open && results.length > 0 && (
        <div className="absolute z-20 mt-2 w-full rounded-2xl border border-ink/10 bg-white shadow-soft overflow-hidden">
          {results.map((r, i) => (
            <button
              key={r.sku}
              type="button"
              onMouseEnter={() => setHighlight(i)}
              onClick={() => choose(r)}
              className={`w-full flex items-center justify-between gap-3 px-4 py-3 text-left border-b border-ink/5 last:border-0 ${
                i === highlight ? 'bg-foam' : 'hover:bg-foam'
              }`}
            >
              {mode === 'sku' ? (
                <div className="min-w-0">
                  <p className="text-sm font-mono text-ink truncate">{r.sku}</p>
                  <p className="text-xs text-ink/40 truncate">{r.name || '—'}</p>
                </div>
              ) : (
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink truncate">{r.name || r.sku}</p>
                  <p className="text-xs text-ink/40 font-mono truncate">{r.sku}</p>
                </div>
              )}
              <Plus className="h-4 w-4 text-wave flex-shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
