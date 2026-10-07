'use client';

import { useState } from 'react';
import { FileSpreadsheet, Loader2 } from 'lucide-react';
import { useSelectedCustomer } from '@/components/SelectedCustomerContext';

/**
 * "Download price list" - fetches /api/pricing/export as an .xlsx and saves it.
 *
 * Follows the header "Pricing as" picker, so staff export the selected
 * customer's prices; a customer login exports its own. The route refuses a
 * staff export with no customer selected, and that message is shown here.
 */
export function PriceListExportButton({ className = '' }: { className?: string }) {
  const { selectedCustomer } = useSelectedCustomer();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (selectedCustomer?.code) params.set('customerCode', selectedCustomer.code);
      const qs = params.toString();
      const res = await fetch(`/api/pricing/export${qs ? `?${qs}` : ''}`, { cache: 'no-store' });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? 'Could not build your price list. Please try again.');
        return;
      }

      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? 'Hayward-Price-List.xlsx';

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`flex flex-col items-end gap-1 print:hidden ${className}`}>
      <button
        onClick={download}
        disabled={busy}
        className="rounded-xl border border-ink/10 bg-white px-4 py-2.5 text-sm font-medium shadow-soft hover:border-splash/40 hover:text-splash disabled:opacity-60 disabled:cursor-wait flex items-center gap-2"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
        {busy ? 'Preparing…' : 'Download price list'}
      </button>
      {error && <p className="text-xs text-coral max-w-xs text-right">{error}</p>}
    </div>
  );
}
