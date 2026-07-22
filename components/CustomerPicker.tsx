'use client';

import { useEffect, useMemo, useState } from 'react';
import { User, ChevronDown, X, Phone, MapPin, Tag, ArrowLeft, Search, AlertTriangle } from 'lucide-react';
import { useSelectedCustomer, SelectedCustomer } from './SelectedCustomerContext';
import { matchesCustomerQuery } from '@/lib/customer-search';

// Header-level "viewing pricing as" picker for the Hayward (aggregate) org.
// Deliberately one shared control rather than a per-page picker — selecting a
// customer here is what makes that customer's pricing apply across Products,
// Pricing, Orders and anywhere else reading the shared context.
//
// Shows EVERY account in Arrow as an individual branch, searchable, with the
// customer groups (Reece, Poolwerx, ...) as buttons above the list for when a
// group-level price is what's wanted.
//
// On pricing accuracy: selecting a group prices as one representative branch,
// which is only correct when every branch in that group shares an
// AUTO_PRICE_TYPE. The API checks that per group and returns
// priceTypeConsistent; where it's false the group button is flagged, because
// silently pricing as an arbitrary branch would be wrong for all the others.

interface PickerCustomer extends SelectedCustomer {
  groupName?: string | null;
}

interface GroupOption {
  groupName: string;
  code: string;
  memberCount: number;
  priceType: string | null;
  priceTypes: string[];
  priceTypeConsistent: boolean;
  priceTypeSource?: 'override' | 'master';
}

export function CustomerPicker() {
  const { selectedCustomer, setSelectedCustomer } = useSelectedCustomer();
  const [open, setOpen] = useState(false);
  const [customers, setCustomers] = useState<PickerCustomer[]>([]);
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewingDetail, setViewingDetail] = useState<SelectedCustomer | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    fetch('/api/customers')
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) {
          setLoadError(data.error ?? 'Could not load customers.');
          setCustomers([]);
          return;
        }
        setCustomers(data.customers ?? []);
        setGroups(data.groups ?? []);
      })
      .catch(() => setLoadError('Could not reach the server.'))
      .finally(() => setLoading(false));
  }, []);

  function pick(customer: SelectedCustomer) {
    setSelectedCustomer(customer);
    setViewingDetail(customer);
  }

  function pickGroup(g: GroupOption) {
    // Carries the representative branch's code — that's what every pricing
    // call downstream resolves against — but displays the group name.
    setSelectedCustomer({ code: g.code, name: g.groupName, priceType: g.priceType });
    setOpen(false);
    setViewingDetail(null);
  }

  function closeAndReset() {
    setOpen(false);
    setViewingDetail(null);
  }

  const addressLine = (c: SelectedCustomer) =>
    [c.street, c.suburb, c.city, c.state, c.postcode].filter(Boolean).join(', ');

  const q = query.trim().toLowerCase();

  // Word-by-word prefix matching over name, code, suburb and state. A plain
  // substring scan fails here for two reasons: Arrow truncates CUSTOMER_NAME at
  // 30 characters, so "REECE IRRIGATION & POOLS DANDENONG" is stored as
  // "...DANDE" and "dandenong" matches nothing; and the words someone types
  // aren't adjacent in the stored value, so "reece dan" can't match either.
  const filtered = useMemo(() => {
    if (!q) return customers;
    return customers.filter((c) =>
      matchesCustomerQuery([c.name, c.code, c.suburb, c.state], query)
    );
  }, [customers, q, query]);

  const visibleGroups = useMemo(
    () => (q ? groups.filter((g) => matchesCustomerQuery([g.groupName], query)) : groups),
    [groups, q, query]
  );

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
        <div className="absolute right-0 z-30 mt-2 w-96 rounded-2xl border border-ink/10 bg-white shadow-soft overflow-hidden">
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
                Select customer
                {customers.length > 0 && (
                  <span className="ml-1.5 font-normal text-ink/40">{customers.length}</span>
                )}
              </p>
            )}
            <div className="flex items-center gap-1">
              {selectedCustomer && !viewingDetail && (
                <button
                  onClick={() => {
                    setSelectedCustomer(null);
                    closeAndReset();
                  }}
                  className="text-xs text-ink/40 hover:text-coral px-1.5"
                >
                  Clear
                </button>
              )}
              <button onClick={closeAndReset} className="p-1 rounded-full hover:bg-ink/5">
                <X className="h-4 w-4 text-ink/40" />
              </button>
            </div>
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
              <div className="px-3 pt-3 pb-2 border-b border-ink/5">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink/30" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search name, code or suburb…"
                    className="w-full rounded-lg border border-ink/10 pl-8 pr-3 py-1.5 text-sm focus:outline-none focus:border-wave/40"
                    autoFocus
                  />
                </div>
              </div>

              {visibleGroups.length > 0 && (
                <div className="px-3 py-2.5 border-b border-ink/5 bg-foam/40">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink/40 mb-1.5">
                    Customer groups
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {visibleGroups.map((g) => (
                      <button
                        key={g.groupName}
                        onClick={() => pickGroup(g)}
                        title={
                          !g.priceTypeConsistent
                            ? `${g.memberCount} branches with DIFFERENT price types (${g.priceTypes.join(', ')}) — pick a branch for exact pricing`
                            : g.priceTypeSource === 'override'
                            ? `${g.memberCount} branches, all priced ${g.priceType} (fixed for the whole group, master data ignored)`
                            : `${g.memberCount} branches, price type ${g.priceType ?? 'n/a'}`
                        }
                        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                          selectedCustomer?.name === g.groupName
                            ? 'border-wave bg-wave/10 text-deep'
                            : g.priceTypeConsistent
                            ? 'border-ink/10 bg-white text-ink/70 hover:border-wave/40 hover:bg-wave/5'
                            : 'border-amber/50 bg-amber/5 text-ink/70 hover:border-amber'
                        }`}
                      >
                        {!g.priceTypeConsistent && <AlertTriangle className="h-3 w-3 text-amber" />}
                        {g.groupName}
                        <span className="text-ink/35">{g.memberCount}</span>
                      </button>
                    ))}
                  </div>
                  {visibleGroups.some((g) => !g.priceTypeConsistent) && (
                    <p className="mt-1.5 text-[11px] leading-snug text-amber">
                      Flagged groups have branches on different price types — a group price would only
                      be right for some of them. Select the individual branch instead.
                    </p>
                  )}
                </div>
              )}

              <div className="max-h-80 overflow-y-auto">
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
                      className={`w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-foam border-b border-ink/5 last:border-0 ${
                        selectedCustomer?.code === c.code ? 'bg-wave/5' : ''
                      }`}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink truncate">{c.name}</p>
                        <p className="text-xs text-ink/40">
                          <span className="font-mono">{c.code}</span>
                          {c.suburb && <span className="ml-2">{c.suburb}</span>}
                          {c.priceType && <span className="ml-2 text-ink/30">{c.priceType}</span>}
                        </p>
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
