import { CheckCircle2, Clock, XCircle, PauseCircle, FileText, ReceiptText } from 'lucide-react';
import { getCustomerAccess } from '@/lib/access';
import { getJSON } from '@/lib/redis';

interface OrderLine {
  orderNo: string;
  orderDate: string;
  expectedDate: string;
  statusFlag: string;
  sku: string;
  qtyOrdered: number;
  qtyShipped: number;
  qtyBackordered: number;
  customerCode: string;
}

const STATUS: Record<string, { label: string; icon: typeof CheckCircle2; className: string }> = {
  C: { label: 'Completed', icon: CheckCircle2, className: 'bg-ink/5 text-ink/50' },
  A: { label: 'Active', icon: Clock, className: 'bg-wave/10 text-wave' },
  X: { label: 'Cancelled', icon: XCircle, className: 'bg-coral/10 text-coral' },
  B: { label: 'Backordered', icon: PauseCircle, className: 'bg-amber/10 text-amber' },
  H: { label: 'On hold', icon: PauseCircle, className: 'bg-amber/10 text-amber' },
  S: { label: 'Standing order', icon: ReceiptText, className: 'bg-wave/10 text-wave' },
  '': { label: 'Draft', icon: FileText, className: 'bg-ink/5 text-ink/50' },
};

function formatDate(value: string | null | undefined) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default async function OrdersPage() {
  const access = await getCustomerAccess();

  if (!access) {
    return <p className="text-ink/60">Select an organization above to see order status.</p>;
  }

  const perCustomer = await Promise.all(
    access.customerCodes.map(async (code) => {
      const lines = (await getJSON<OrderLine[]>(`orders:${code}`)) ?? [];
      return lines.map((line) => ({ ...line, customerCode: code }));
    })
  );

  const orders = perCustomer
    .flat()
    .sort((a, b) => new Date(b.orderDate).getTime() - new Date(a.orderDate).getTime());

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl text-deep font-bold">Orders</h1>
        <p className="text-ink/50 mt-1">
          {access.isHeadOffice ? 'Across all your locations.' : 'For your location.'}
        </p>
      </div>

      {orders.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink/10 shadow-soft py-16 flex flex-col items-center gap-2">
          <ReceiptText className="h-8 w-8 text-ink/20" />
          <p className="text-ink/40">No orders found in the last 90 days.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-ink/10 bg-white shadow-soft">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink/10 text-left text-ink/40">
                <th className="px-5 py-3.5 font-medium">Order #</th>
                {access.isHeadOffice && <th className="px-5 py-3.5 font-medium">Branch</th>}
                <th className="px-5 py-3.5 font-medium">Date</th>
                <th className="px-5 py-3.5 font-medium">SKU</th>
                <th className="px-5 py-3.5 font-medium text-right">Ordered</th>
                <th className="px-5 py-3.5 font-medium text-right">Shipped</th>
                <th className="px-5 py-3.5 font-medium text-right">Backordered</th>
                <th className="px-5 py-3.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o, i) => {
                const status = STATUS[o.statusFlag] ?? {
                  label: o.statusFlag || 'Unknown',
                  icon: FileText,
                  className: 'bg-ink/5 text-ink/50',
                };
                const StatusIcon = status.icon;
                return (
                  <tr key={`${o.orderNo}-${o.sku}-${i}`} className="border-b border-ink/5 last:border-0">
                    <td className="px-5 py-3.5 font-medium">{o.orderNo}</td>
                    {access.isHeadOffice && (
                      <td className="px-5 py-3.5 text-ink/50">{o.customerCode}</td>
                    )}
                    <td className="px-5 py-3.5 text-ink/50">{formatDate(o.orderDate)}</td>
                    <td className="px-5 py-3.5 font-mono text-xs">{o.sku}</td>
                    <td className="px-5 py-3.5 text-right">{o.qtyOrdered}</td>
                    <td className="px-5 py-3.5 text-right">{o.qtyShipped}</td>
                    <td className="px-5 py-3.5 text-right">{o.qtyBackordered || '-'}</td>
                    <td className="px-5 py-3.5">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${status.className}`}
                      >
                        <StatusIcon className="h-3 w-3" />
                        {status.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
