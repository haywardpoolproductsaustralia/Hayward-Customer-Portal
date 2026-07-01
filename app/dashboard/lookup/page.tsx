'use client';

import { useEffect, useMemo, useState } from 'react';
import { Search, Phone, MapPin, User, Hash, Tag, Copy, Check, Users } from 'lucide-react';

interface Branch {
  code: string;
  name: string;
  contactName?: string | null;
  phone?: string | null;
  street?: string | null;
  suburb?: string | null;
  city?: string | null;
  state?: string | null;
  postcode?: string | null;
  priceType?: string | null;
}

// Normalize AU phone numbers to a national significant number (no country
// code, no trunk 0) so a caller-ID "+61 3 9793 1234" matches a stored
// "03 9793 1234". All non-digits are stripped before comparing.
function normPhone(s?: string | null): string {
  let d = (s ?? '').replace(/\D/g, '');
  if (d.startsWith('0061')) d = d.slice(4);
  else if (d.startsWith('61')) d = d.slice(2);
  else if (d.startsWith('0')) d = d.slice(1);
  return d;
}

export default function CustomerLookupPage() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notStaff, setNotStaff] = useState(false);
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/customers?level=branch')
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) { setError(data.error ?? 'Could not load customers.'); return; }
        if (data.isAggregate === false) { setNotStaff(true); return; }
        setBranches(data.customers ?? []);
      })
      .catch(() => setError('Could not reach the server.'))
      .finally(() => setLoading(false));
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const qDigits = normPhone(query);
    const byPhone = qDigits.length >= 3;
    return branches
      .filter((b) => {
        const hay = [b.name, b.code, b.suburb, b.city, b.state, b.postcode, b.contactName]
          .filter(Boolean).join(' ').toLowerCase();
        if (hay.includes(q)) return true;
        if (byPhone && b.phone) return normPhone(b.phone).includes(qDigits);
        return false;
      })
      .slice(0, 100);
  }, [query, branches]);

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200);
    } catch { /* clipboard blocked — ignore */ }
  }

  const addressLine = (b: Branch) =>
    [b.street, b.suburb, b.city, b.state, b.postcode].filter(Boolean).join(', ');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-deep">Customer Lookup</h1>
        <p className="text-sm text-ink/50 mt-1">
          Find a branch by phone, customer number, name, or postcode to verify a caller.
        </p>
      </div>

      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-ink/30" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. 03 9793 1234, REEC12, Reece Dandenong, 3175…"
          autoFocus
          className="w-full rounded-xl border border-ink/10 bg-white pl-10 pr-4 py-3 text-sm shadow-soft focus:outline-none focus:border-wave/40 focus:ring-2 focus:ring-wave/20"
        />
      </div>

      {loading ? (
        <p className="text-sm text-ink/40 py-10 text-center">Loading customers…</p>
      ) : notStaff ? (
        <div className="rounded-2xl bg-white border border-amber/20 shadow-soft px-5 py-4 text-sm text-ink/70">
          This lookup is for Hayward staff. Switch to the Hayward organisation to use it.
        </div>
      ) : error ? (
        <p className="text-sm text-coral py-10 text-center">{error}</p>
      ) : !query.trim() ? (
        <div className="rounded-2xl bg-white border border-ink/10 shadow-soft px-5 py-8 text-center">
          <Users className="h-6 w-6 text-ink/20 mx-auto mb-2" />
          <p className="text-sm text-ink/50">
            Start typing to search {branches.length.toLocaleString()} branches.
          </p>
          <p className="text-xs text-ink/30 mt-1">
            Phone matches regardless of spacing or +61 / 0 prefix.
          </p>
        </div>
      ) : results.length === 0 ? (
        <p className="text-sm text-ink/40 py-10 text-center">No branch matches “{query}”.</p>
      ) : (
        <>
          <p className="text-xs text-ink/40">
            {results.length}{results.length === 100 ? '+' : ''} match{results.length === 1 ? '' : 'es'}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {results.map((b) => (
              <div key={b.code} className="rounded-2xl border border-ink/10 bg-white shadow-soft p-4 space-y-3">
                <p className="font-semibold text-deep">{b.name}</p>

                <div className="space-y-2">
                  <VerifyRow
                    icon={<Hash className="h-4 w-4 text-ink/30" />}
                    label="Customer #"
                    value={b.code}
                    mono
                    onCopy={() => copy(b.code, `code-${b.code}`)}
                    copied={copied === `code-${b.code}`}
                  />
                  <VerifyRow
                    icon={<Phone className="h-4 w-4 text-ink/30" />}
                    label="Phone"
                    value={b.phone || '—'}
                    onCopy={b.phone ? () => copy(b.phone!, `ph-${b.code}`) : undefined}
                    copied={copied === `ph-${b.code}`}
                  />
                </div>

                <div className="pt-2 border-t border-ink/5 space-y-1.5 text-sm text-ink/70">
                  {b.contactName && (
                    <p className="flex items-center gap-2"><User className="h-4 w-4 text-ink/30" />{b.contactName}</p>
                  )}
                  {addressLine(b) && (
                    <p className="flex items-start gap-2"><MapPin className="h-4 w-4 text-ink/30 mt-0.5 flex-shrink-0" />{addressLine(b)}</p>
                  )}
                  {b.priceType && (
                    <p className="flex items-center gap-2"><Tag className="h-4 w-4 text-ink/30" />Price type: {b.priceType}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function VerifyRow({ icon, label, value, mono, onCopy, copied }: {
  icon: React.ReactNode; label: string; value: string; mono?: boolean;
  onCopy?: () => void; copied?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <span className="text-xs text-ink/40 w-20 flex-shrink-0">{label}</span>
      <span className={`text-sm text-ink flex-1 min-w-0 truncate ${mono ? 'font-mono' : ''}`}>{value}</span>
      {onCopy && (
        <button onClick={onCopy} className="p-1 rounded hover:bg-ink/5 flex-shrink-0" title="Copy">
          {copied ? <Check className="h-3.5 w-3.5 text-splash" /> : <Copy className="h-3.5 w-3.5 text-ink/30" />}
        </button>
      )}
    </div>
  );
}
