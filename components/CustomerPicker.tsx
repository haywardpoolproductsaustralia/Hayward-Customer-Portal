'use client';

import { useEffect, useState } from 'react';
import { User, ChevronDown, X, Phone, MapPin, Tag, ArrowLeft, Search } from 'lucide-react';
import { useSelectedCustomer, SelectedCustomer } from './SelectedCustomerContext';

// Header-level "viewing pricing as" picker for the Hayward (aggregate)
// org. Deliberately one shared control rather than a per-page picker -
// selecting a customer here is what makes that customer's pricing apply
// "across the board" on Products, Pricing, and anywhere else that reads
// from the shared context, instead of having to re-pick per page.
//
// Default view is one row per group (every Reece branch collapses to a
// single "Reece"), since branches in a group share one price type. The
// "Show all branches" toggle switches to level=branch so an agent can
// search for and pick a specific store (e.g. Reece Dandenong) when they
// need that exact account, not just its pricing.
export function CustomerPicker() {
  const { selectedCustomer, setSelectedCustomer } = useSelectedCustomer();
  const [open, setOpen] = useState(false);
  const [customers, setCustomers] = useState<SelectedCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewingDetail, setViewingDetail] = useState<SelectedCustomer | null>(null);
  const [allBranches, setAllBranches] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    fetch(`/api/customers${allBranches ? '?level=branch' : ''}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) {
          setLoadError(data.error ?? 'Could not load customers.');
          setCustomers([]);
          return;
        }
        setCustomers(data.customers ?? []);
      })
      .catch(() => setLoadError('Could not reach the server.'))
      .finally(() => setLoading(false));
  }, [allBranches]);

  function pick(customer: SelectedCustomer) {
    setSelectedCustomer(customer);
    setViewingDetail(customer);
  }

  function closeAndReset() {
    setOpen(false);
    setViewingDetail(null);
  }

  const addressLine = (c: SelectedCustomer) =>
    [c.street, c.suburb, c.city, c.state, c.postcode].filter(Boolean).join(', ');

  const q = query.trim().toLowerCase();
  const filtered = q
    ? customers.filter(
        (c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q)
      )
    : customers;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
          selectedCustomer
            ? 'border-wave/30 bg-wave/5 text-deep'
            : 'border-ink/10 bg-white text-ink/60 hover:border-wave/30'
        }`}
      >
        <User className="h-3.5 w-3.5" />
        {selectedCustomer ? `Pricing as: ${selectedCustomer.name}` : 'All customers'}
        <ChevronDown className="h-3.5 w-3.5" />
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-2 w-80 rounded-2xl border border-ink/10 bg-white shadow-soft overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-ink/10">
            {viewingDetail ? (
              <button
                onClick={() => setViewingDetail(null)}
                className="flex items-center gap-1.5 text-sm font-medium text-ink/60 hover:text-ink"
              >
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
            ) : (
              <p className="text-sm font-semibold text-deep">
                {allBranches ? 'All branches' : 'All customers'}
              </p>
            )}
            <button onClick={closeAndReset} className="p-1 rounded-full hover:bg-ink/5">
              <X className="h-4 w-4 text-ink/40" />
            </button>
          </div>

          {viewingDetail ? (
            <div className="p-4 space-y-3">
              <div>
                <p className="font-semibold text-deep">{viewingDetail.name}</p>
                <p className="text-xs text-ink/40 font-mono">{viewingDetail.code}</p>
              </div>
              {viewingDetail.contactName && (
                <div className="flex items-center gap-2 text-sm text-ink/70">
                  <User className="h-4 w-4 text-ink/30" /> {viewingDetail.contactName}
                </div>
              )}
              {viewingDetail.phone && (
                <div className="flex items-center gap-2 text-sm text-ink/70">
                  <Phone className="h-4 w-4 text-ink/30" /> {viewingDetail.phone}
                </div>
              )}
              {addressLine(viewingDetail) && (
                <div className="flex items-start gap-2 text-sm text-ink/70">
                  <MapPin className="h-4 w-4 text-ink/30 mt-0.5 flex-shrink-0" /> {addressLine(viewingDetail)}
                </div>
              )}
              {viewingDetail.priceType && (
                <div className="flex items-center gap-2 text-sm text-ink/70">
                  <Tag className="h-4 w-4 text-ink/30" /> Price type: {viewingDetail.priceType}
                </div>
              )}
              <div className="pt-2 border-t border-ink/5 flex items-center justify-between">
                <span className="text-xs text-splash font-medium">Now pricing as this customer</span>
                <button
                  onClick={() => {
                    setSelectedCustomer(null);
                    closeAndReset();
                  }}
                  className="text-xs text-ink/40 hover:text-coral"
                >
                  Clear
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="px-3 pt-3 pb-2 border-b border-ink/5 space-y-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink/30" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={allBranches ? 'Search all branches…' : 'Search customers…'}
                    className="w-full rounded-lg border border-ink/10 pl-8 pr-3 py-1.5 text-sm focus:outline-none focus:border-wave/40"
                    autoFocus
                  />
                </div>
                <label className="flex items-center gap-1.5 text-xs text-ink/60 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={allBranches}
                    onChange={(e) => setAllBranches(e.target.checked)}
                  />
                  Show all branches
                </label>
              </div>
              <div className="max-h-72 overflow-y-auto">
                {loading ? (
                  <p className="px-4 py-6 text-sm text-ink/40 text-center">Loading...</p>
                ) : loadError ? (
                  <p className="px-4 py-6 text-sm text-coral text-center">{loadError}</p>
                ) : filtered.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-ink/40 text-center">
                    {customers.length === 0
                      ? 'No customers found - the sync job may need to run again.'
                      : 'No matches.'}
                  </p>
                ) : (
                  filtered.map((c) => (
                    <button
                      key={c.code}
                      onClick={() => pick(c)}
                      className={`w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-foam border-b border-ink/5 last:border-0 ${
                        selectedCustomer?.code === c.code ? 'bg-wave/5' : ''
                      }`}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink truncate">{c.name}</p>
                        <p className="text-xs text-ink/40 font-mono">{c.code}</p>
                      </div>
                      {selectedCustomer?.code === c.code && (
                        <span className="text-[11px] font-semibold text-wave flex-shrink-0">Selected</span>
                      )}
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
