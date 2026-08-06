'use client';

import { useEffect, useState } from 'react';
import { useAutoRefresh } from '@/lib/auto-refresh';
import { getCustomerAccess } from '@/lib/access';

interface ArrowLine {
  po: string;
  line: number;
  arrowStock: string;
  supplierSku: string;
  description: string | null;
  stockCategory: string;  // <-- NEW FIELD
  creditor: string | null;
  qtyOrdered: number;
  qtyReceived: number;
  qtyOutstanding: number;
  orderDate: string | null;
  requestedDate: string | null;
}

export default function ReconciliationPage() {
  const [lines, setLines] = useState<ArrowLine[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>(''); // filter state
  const [loading, setLoading] = useState(true);
  const { lastRefresh } = useAutoRefresh();

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        // Fetch from your reconciliation API endpoint
        const resp = await fetch('/api/recon/lines');
        const data = await resp.json();
        setLines(data);
      } catch (err) {
        console.error('Failed to load reconciliation data:', err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [lastRefresh]);

  // Filter lines by selected category
  const filteredLines = selectedCategory 
    ? lines.filter(line => line.stockCategory === selectedCategory)
    : lines;

  // Get unique categories from data
  const categories = Array.from(new Set(lines.map(l => l.stockCategory).filter(Boolean)))
    .sort() as string[];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Order Reconciliation & ETA</h1>
        <span className="text-sm text-gray-500">Updated {new Date(lastRefresh).toLocaleString()}</span>
      </div>

      {/* Category Filter */}
      <div className="flex items-center gap-4 bg-white p-4 rounded-lg border">
        <label htmlFor="category-filter" className="font-semibold">Filter by Stock Category:</label>
        <select
          id="category-filter"
          value={selectedCategory}
          onChange={(e) => setSelectedCategory(e.target.value)}
          className="px-3 py-2 border rounded"
        >
          <option value="">All Categories</option>
          {categories.map(cat => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>
        {selectedCategory && (
          <span className="text-sm text-gray-600">
            Showing {filteredLines.length} lines (Category: {selectedCategory})
          </span>
        )}
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-5 gap-4">
        <div className="bg-white p-4 rounded border">
          <div className="text-gray-600 text-sm">PO Lines</div>
          <div className="text-2xl font-bold">{filteredLines.length}</div>
        </div>
        <div className="bg-white p-4 rounded border">
          <div className="text-gray-600 text-sm">Exceptions</div>
          <div className="text-2xl font-bold">{filteredLines.filter(l => l.qtyOutstanding > 0).length}</div>
        </div>
        <div className="bg-white p-4 rounded border">
          <div className="text-gray-600 text-sm">In Transit</div>
          <div className="text-2xl font-bold">—</div>
        </div>
        <div className="bg-white p-4 rounded border">
          <div className="text-gray-600 text-sm">Delivered</div>
          <div className="text-2xl font-bold">{filteredLines.filter(l => l.qtyOutstanding === 0).length}</div>
        </div>
        <div className="bg-white p-4 rounded border">
          <div className="text-gray-600 text-sm">Late vs Request</div>
          <div className="text-2xl font-bold">—</div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 border-b">
            <tr>
              <th className="px-4 py-2 text-left">PO</th>
              <th className="px-4 py-2 text-left">Arrow Stock</th>
              <th className="px-4 py-2 text-left">Supplier SKU</th>
              <th className="px-4 py-2 text-left">Category</th>
              <th className="px-4 py-2 text-left">Description</th>
              <th className="px-4 py-2 text-right">Ordered</th>
              <th className="px-4 py-2 text-right">Received</th>
              <th className="px-4 py-2 text-right">Outstanding</th>
              <th className="px-4 py-2 text-left">Order Date</th>
              <th className="px-4 py-2 text-left">ETA</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={10} className="px-4 py-4 text-center">Loading...</td></tr>
            ) : filteredLines.length === 0 ? (
              <tr><td colSpan={10} className="px-4 py-4 text-center text-gray-500">
                {selectedCategory ? 'No lines match selected category' : 'No reconciliation data'}
              </td></tr>
            ) : (
              filteredLines.map((line, idx) => (
                <tr key={idx} className="border-b hover:bg-gray-50">
                  <td className="px-4 py-2 font-mono">{line.po}</td>
                  <td className="px-4 py-2 font-mono">{line.arrowStock}</td>
                  <td className="px-4 py-2 font-mono">{line.supplierSku || '—'}</td>
                  <td className="px-4 py-2 bg-blue-50">{line.stockCategory}</td>
                  <td className="px-4 py-2">{line.description}</td>
                  <td className="px-4 py-2 text-right">{line.qtyOrdered}</td>
                  <td className="px-4 py-2 text-right">{line.qtyReceived}</td>
                  <td className="px-4 py-2 text-right font-semibold">{line.qtyOutstanding}</td>
                  <td className="px-4 py-2">{line.orderDate}</td>
                  <td className="px-4 py-2">{line.requestedDate}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
