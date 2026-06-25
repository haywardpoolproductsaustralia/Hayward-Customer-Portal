'use client';

import { createContext, useContext, useState, ReactNode } from 'react';

export interface SelectedCustomer {
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

interface SelectedCustomerContextValue {
  selectedCustomer: SelectedCustomer | null;
  setSelectedCustomer: (c: SelectedCustomer | null) => void;
}

const SelectedCustomerContext = createContext<SelectedCustomerContextValue | undefined>(undefined);

// Holds "which customer's pricing am I viewing as" for the whole
// dashboard session - lives in the layout so it survives navigating
// between Products, Pricing, etc. without needing to re-select on every
// page. Resets on a hard refresh, which is the right trade-off for a
// "currently viewing as" convenience setting, not something that needs
// to persist forever.
export function SelectedCustomerProvider({ children }: { children: ReactNode }) {
  const [selectedCustomer, setSelectedCustomer] = useState<SelectedCustomer | null>(null);
  return (
    <SelectedCustomerContext.Provider value={{ selectedCustomer, setSelectedCustomer }}>
      {children}
    </SelectedCustomerContext.Provider>
  );
}

export function useSelectedCustomer() {
  const ctx = useContext(SelectedCustomerContext);
  if (!ctx) throw new Error('useSelectedCustomer must be used within SelectedCustomerProvider');
  return ctx;
}
