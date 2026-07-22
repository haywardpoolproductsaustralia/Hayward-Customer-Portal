'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, ChevronDown, Check, X } from 'lucide-react';
import { matchesCustomerQuery } from '@/lib/customer-search';

export interface AccountChoice {
  code: string;
  name: string;
  street?: string | null;
  suburb?: string | null;
  city?: string | null;
  state?: string | null;
  postcode?: string | null;
}

// One control instead of the previous filter-box-plus-dropdown pair. Type to
// narrow, click to choose; the chosen account shows in the closed control, so
// there's no state where the filter says one thing and the select another.
//
// Matching uses the shared matchesCustomerQuery, so this behaves like the
// lookup page and the header picker — word-by-word prefix matching in both
// directions, which is what makes truncated Arrow names findable. A native
// <select> can't do any of that, which is why this is a listbox.
export function AccountSelect({
  accounts,
  value,
  onChange,
  disabled,
}: {
  accounts: AccountChoice[];
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = accounts.find((a) => a.code === value) ?? null;

  const filtered = useMemo(() => {
    if (!query.trim()) return accounts;
    return accounts.filter((a) =>
      matchesCustomerQuery([a.name, a.code, a.suburb, a.city, a.state, a.postcode], query)
    );
  }, [accounts, query]);

  useEffect(() => setActive(0), [query]);

  // Close on an outside click or Escape, so it behaves like the native control
  // it replaces.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setQuery('');
  }, [open]);

  function choose(code: string) {
    onChange(code);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && filtered[active]) { e.preventDefault(); choose(filtered[active].code); }
  }

  const line = (a: AccountChoice) =>
    [a.suburb, a.state, a.postcode].map((p) => (p ?? '').trim()).filter(Boolean).join(' ');

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        disabled={disabled || accounts.length === 0}
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm text-left outline-none transition-colors ${
          disabled || accounts.length === 0
            ? 'border-ink/10 bg-ink/5 text-ink/30 cursor-not-allowed'
            : open
            ? 'border-wave bg-white'
            : 'border-ink/10 bg-white hover:border-wave/40'
        }`}
      >
        {selected ? (
          <span className="min-w-0 truncate">
            <span className="text-ink">{selected.name}</span>
            <span className="text-ink/40 ml-1.5 font-mono text-xs">{selected.code}</span>
          </span>
        ) : (
          <span className="text-ink/40">
            {accounts.length === 0 ? 'No accounts available' : 'Search or select an account…'}
          </span>
        )}
        <span className="flex items-center gap-1 flex-shrink-0">
          {selected && !disabled && (
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => { e.stopPropagation(); onChange(''); }}
              className="p-0.5 rounded hover:bg-ink/5"
              aria-label="Clear selected account"
            >
              <X className="h-3.5 w-3.5 text-ink/30" />
            </span>
          )}
          <ChevronDown className="h-4 w-4 text-ink/30" />
        </span>
      </button>

      {open && (
        <div className="absolute z-40 mt-1 w-full rounded-xl border border-ink/10 bg-white shadow-soft overflow-hidden">
          <div className="p-2 border-b border-ink/5">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink/30" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Search by name, code or suburb…"
                className="w-full rounded-lg border border-ink/10 pl-8 pr-3 py-1.5 text-sm outline-none focus:border-wave/40"
              />
            </div>
          </div>

          <div className="max-h-64 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-sm text-ink/40 text-center">No accounts match that.</p>
            ) : (
              filtered.slice(0, 300).map((a, i) => (
                <button
                  key={a.code}
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(a.code)}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left border-b border-ink/5 last:border-0 ${
                    i === active ? 'bg-foam' : ''
                  } ${a.code === value ? 'bg-wave/5' : ''}`}
                >
                  <span className="min-w-0">
                    <span className="block text-sm text-ink truncate">{a.name}</span>
                    <span className="block text-xs text-ink/40">
                      <span className="font-mono">{a.code}</span>
                      {line(a) && <span className="ml-2">{line(a)}</span>}
                    </span>
                  </span>
                  {a.code === value && <Check className="h-4 w-4 text-wave flex-shrink-0" />}
                </button>
              ))
            )}
            {filtered.length > 300 && (
              <p className="px-3 py-2 text-xs text-ink/40 text-center border-t border-ink/5">
                Showing 300 of {filtered.length} — keep typing to narrow.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
