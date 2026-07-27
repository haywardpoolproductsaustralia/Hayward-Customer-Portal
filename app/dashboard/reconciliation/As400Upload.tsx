'use client';

import { useRef, useState } from 'react';
import { Upload, Loader2, CheckCircle2, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';

/** Manual AS400 loader — stands in for the Snowflake feed until the
 *  service account exists. Writes recon:as400_orders via the upload route. */
export default function As400Upload({ uploadedAt, rows }: { uploadedAt: string | null; rows: number }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function send(file: File) {
    setBusy(true); setMsg(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/reconciliation/upload-as400', { method: 'POST', body: fd });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setMsg({ ok: true, text: `Loaded ${j.rows.toLocaleString()} lines across ${j.pos.toLocaleString()} POs` +
        (j.skipped ? ` · ${j.skipped.toLocaleString()} rows skipped` : '') });
      setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const stamp = uploadedAt
    ? new Date(uploadedAt).toLocaleString('en-AU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div className="rounded-2xl border border-ink/10 bg-white shadow-soft">
      <button onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-foam/50 rounded-2xl">
        {open ? <ChevronDown className="h-4 w-4 text-ink/30" /> : <ChevronRight className="h-4 w-4 text-ink/30" />}
        <Upload className="h-4 w-4 text-wave" />
        <span className="text-sm font-medium text-ink">AS400 data</span>
        <span className="text-xs text-ink/40">
          {stamp ? `${rows.toLocaleString()} lines · uploaded ${stamp}` : 'not loaded yet'}
        </span>
        <span className="ml-auto text-[11px] text-ink/35">manual until the Snowflake service account is live</span>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-ink/5">
          <p className="text-xs text-ink/50 mb-3 leading-relaxed">
            Run the AS400 query in Snowsight, download the results, and drop the file here.
            CSV or XLSX both work. Rows are re-aggregated to PO + SKU on upload, so it doesn&apos;t
            matter whether you ran the aggregated or the raw version. This replaces the previous
            upload entirely.
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <input ref={input} type="file" accept=".csv,.xlsx,.xls" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) send(f); e.target.value = ''; }} />
            <button onClick={() => input.current?.click()} disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg bg-wave px-3.5 py-2 text-sm font-medium text-white hover:bg-deep disabled:opacity-50">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {busy ? 'Uploading…' : 'Choose file'}
            </button>
            {msg && (
              <span className={`inline-flex items-center gap-1.5 text-sm ${msg.ok ? 'text-splash' : 'text-coral'}`}>
                {msg.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                {msg.text}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
