'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, X, Search, CornerDownLeft } from 'lucide-react';

interface Props {
  label: string;
  placeholder: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
}

const MAX_SHOWN = 100;

// Combo-box: type to narrow the list, then pick with a click, arrow keys + Enter, or just
// press Enter to apply what you typed. The parent filter is only updated on commit (not on
// every keystroke) — the Orders table has thousands of lines and re-filtering per keystroke
// made typing lag.
export function SearchableSelect({ label, placeholder, options, value, onChange, mono = true }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const q = query.trim();
  const { shown, total } = useMemo(() => {
    const u = q.toUpperCase();
    const all = u ? options.filter((o) => o.toUpperCase().includes(u)) : options;
    return { shown: all.slice(0, MAX_SHOWN), total: all.length };
  }, [q, options]);

  // Reset keyboard highlight whenever the list changes
  useEffect(() => { setActive(0); }, [q, open]);

  // Keep the highlighted row scrolled into view
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function commit(v: string) {
    onChange(v);
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  }

  function clear(e: React.MouseEvent) {
    e.stopPropagation();
    onChange('');
    setQuery('');
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setOpen(true);
        setActive((i) => Math.min(i + 1, shown.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
        break;
      case 'Enter': {
        e.preventDefault();
        // Exact option typed, or a single remaining match → select it.
        // Otherwise apply the typed text as-is (it still works as a substring filter).
        const exact = shown.find((o) => o.toUpperCase() === q.toUpperCase());
        if (exact) commit(exact);
        else if (shown.length === 1) commit(shown[0]);
        else if (q && shown[active] && active > 0) commit(shown[active]);
        else if (q) commit(q);
        else if (shown[active]) commit(shown[active]);
        break;
      }
      case 'Escape':
        setOpen(false);
        setQuery('');
        inputRef.current?.blur();
        break;
    }
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
        onClick={() => { setOpen(true); inputRef.current?.focus(); }}
        className={`flex items-center gap-2 rounded-lg border bg-white px-3 py-2 cursor-text transition-colors ${
          open ? 'border-wave ring-2 ring-wave/20' : 'border-ink/10 hover:border-ink/20'
        }`}
      >
        <Search className="h-3.5 w-3.5 text-ink/30 flex-shrink-0" />
        <input
          ref={inputRef}
          value={open ? query : value}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={open && value ? value : placeholder}
          autoComplete="off"
          spellCheck={false}
          className={`flex-1 text-sm outline-none bg-transparent min-w-0 ${mono && (open ? query : value) ? 'font-mono' : ''}`}
        />
        {value ? (
          <button
            type="button"
            onClick={clear}
            onMouseDown={(e) => e.preventDefault()}
            tabIndex={-1}
            className="flex-shrink-0 p-0.5 rounded-full hover:bg-ink/5"
          >
            <X className="h-3.5 w-3.5 text-ink/40" />
          </button>
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-ink/30 flex-shrink-0" />
        )}
      </div>

      {open && (
        <div className="absolute z-20 mt-1.5 w-full rounded-xl border border-deep/15 bg-white shadow-[0_12px_32px_-8px_rgba(7,89,133,0.25)] overflow-hidden">
          <div ref={listRef} className="max-h-60 overflow-y-auto py-1">
            {shown.length === 0 ? (
              <p className="px-3 py-3 text-sm text-ink/40">No matches{q ? ` for “${q}”` : ''}</p>
            ) : (
              shown.map((opt, i) => {
                const selected = opt === value;
                const highlighted = i === active;
                return (
                  <button
                    key={opt}
                    type="button"
                    tabIndex={-1}
                    onMouseDown={(e) => e.preventDefault()} // prevent blur before click
                    onMouseEnter={() => setActive(i)}
                    onClick={() => commit(opt)}
                    className={`w-full text-left flex items-center gap-2 px-3 py-1.5 text-sm transition-colors ${
                      mono ? 'font-mono' : ''
                    } ${
                      highlighted ? 'bg-deep text-white' : selected ? 'bg-foam text-deep font-semibold' : 'text-ink'
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${highlighted ? 'bg-sky-300' : selected ? 'bg-wave' : 'bg-transparent'}`} />
                    <span className="truncate">{opt}</span>
                  </button>
                );
              })
            )}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-ink/5 bg-foam/60 px-3 py-1.5 text-[11px] text-ink/50">
            <span>
              {total > MAX_SHOWN ? `Showing ${MAX_SHOWN} of ${total}` : `${total} match${total === 1 ? '' : 'es'}`}
            </span>
            <span className="flex items-center gap-1 whitespace-nowrap">
              <CornerDownLeft className="h-3 w-3" />
              {q ? 'apply' : 'select'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
