'use client';

import { useMemo, useRef, useState } from 'react';
import { ChevronDown, X, Search } from 'lucide-react';

interface Props {
  label: string;
  placeholder: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
}

// Combo-box: type to filter the list, click to select, clear to reset.
// Used for the Orders page order-number / SKU filters where copy-pasting
// is error-prone but free-text search is still needed for power users.
export function SearchableSelect({ label, placeholder, options, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return options.slice(0, 100); // cap at 100 so it doesn't lag with huge lists
    return options.filter((o) => o.toUpperCase().includes(q)).slice(0, 100);
  }, [query, options]);

  function select(opt: string) {
    onChange(opt);
    setQuery('');
    setOpen(false);
  }

  function clear(e: React.MouseEvent) {
    e.stopPropagation();
    onChange('');
    setQuery('');
  }

  function handleBlur(e: React.FocusEvent) {
    // Only close if focus left the whole component
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setOpen(false);
      setQuery('');
    }
  }

  return (
    <div onBlur={handleBlur} className="relative">
      <label className="block text-xs font-medium text-ink/40 mb-1">{label}</label>
      <div
        onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 0); }}
        className={`flex items-center gap-2 rounded-lg border bg-white px-3 py-2 cursor-text transition-colors ${
          open ? 'border-wave ring-2 ring-wave/20' : 'border-ink/10 hover:border-ink/20'
        }`}
      >
        <Search className="h-3.5 w-3.5 text-ink/30 flex-shrink-0" />
        {open ? (
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={value || placeholder}
            className="flex-1 text-sm outline-none bg-transparent min-w-0"
          />
        ) : (
          <span className={`flex-1 text-sm truncate ${value ? 'text-ink' : 'text-ink/30'}`}>
            {value || placeholder}
          </span>
        )}
        {value ? (
          <button onClick={clear} tabIndex={-1} className="flex-shrink-0 p-0.5 rounded-full hover:bg-ink/5">
            <X className="h-3.5 w-3.5 text-ink/40" />
          </button>
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-ink/30 flex-shrink-0" />
        )}
      </div>

      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-xl border border-ink/10 bg-white shadow-soft overflow-hidden max-h-56 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-3 py-2.5 text-sm text-ink/40">No matches</p>
          ) : (
            filtered.map((opt) => (
              <button
                key={opt}
                tabIndex={0}
                onMouseDown={(e) => e.preventDefault()} // prevent blur before click
                onClick={() => select(opt)}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-foam border-b border-ink/5 last:border-0 font-mono ${
                  opt === value ? 'bg-wave/5 text-wave font-semibold' : 'text-ink'
                }`}
              >
                {opt}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
