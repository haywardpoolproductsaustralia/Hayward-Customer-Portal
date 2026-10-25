'use client';

import { useMemo, useRef, useState } from 'react';
import { ChevronDown, X, Search } from 'lucide-react';

interface Props {
  label: string;
  placeholder: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
  /**
   * true (default): free-text mode — every keystroke is pushed to onChange so the
   * parent filters as you type; the dropdown is just a convenience for picking an
   * exact value. false: pick-only mode — typing narrows the list but onChange only
   * fires when an option is chosen (used where the value must be one of the options,
   * e.g. Branch, which maps label → code).
   */
  liveFilter?: boolean;
}

// Combo-box: type to filter, pick from the list or just keep typing, clear to reset.
// Used for the Orders page order-number / SKU / branch filters where
// copy-pasting is error-prone but free-text search is still needed.
export function SearchableSelect({
  label,
  placeholder,
  options,
  value,
  onChange,
  mono = true,
  liveFilter = true,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pickQuery, setPickQuery] = useState(''); // only used in pick-only mode
  const inputRef = useRef<HTMLInputElement>(null);

  const query = liveFilter ? value : pickQuery;

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return options.slice(0, 100); // cap at 100 so it doesn't lag with huge lists
    return options.filter((o) => o.toUpperCase().includes(q)).slice(0, 100);
  }, [query, options]);

  function select(opt: string) {
    onChange(opt);
    setPickQuery('');
    setOpen(false);
    inputRef.current?.blur();
  }

  function clear(e: React.MouseEvent) {
    e.stopPropagation();
    onChange('');
    setPickQuery('');
    setOpen(false);
  }

  function handleInput(v: string) {
    if (liveFilter) onChange(v);
    else setPickQuery(v);
    setOpen(true);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    } else if (e.key === 'Enter') {
      // Enter = keep what's typed (live mode) or take the single remaining match (pick mode)
      if (!liveFilter && filtered.length === 1) select(filtered[0]);
      else setOpen(false);
    }
  }

  function handleBlur(e: React.FocusEvent) {
    // Only close if focus left the whole component
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setOpen(false);
      setPickQuery('');
    }
  }

  const displayValue = liveFilter ? value : open ? pickQuery : value;
  const inputPlaceholder = !liveFilter && open && value ? value : placeholder;

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
          value={displayValue}
          onChange={(e) => handleInput(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={inputPlaceholder}
          autoComplete="off"
          spellCheck={false}
          className={`flex-1 text-sm outline-none bg-transparent min-w-0 ${
            mono && displayValue ? 'font-mono' : ''
          }`}
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

      {open && filtered.length > 0 && !(liveFilter && filtered.length === 1 && filtered[0] === value) && (
        <div className="absolute z-20 mt-1 w-full rounded-xl border border-ink/10 bg-white shadow-soft overflow-hidden max-h-56 overflow-y-auto">
          {filtered.map((opt) => (
            <button
              key={opt}
              type="button"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()} // prevent blur before click
              onClick={() => select(opt)}
              className={`w-full text-left pl-9 pr-3 py-2 text-sm hover:bg-foam border-b border-ink/5 last:border-0 ${mono ? 'font-mono' : ''} ${
                opt === value ? 'bg-wave/5 text-wave font-semibold' : 'text-ink'
              }`}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
