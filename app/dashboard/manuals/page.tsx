'use client';

import { useMemo, useState } from 'react';
import { Search, BookOpen, Download, Eye } from 'lucide-react';
import manuals from '@/config/manuals.json';

interface Manual {
  title: string;
  url: string;
  tags: string[];
}

export default function ManualsPage() {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return manuals as Manual[];
    return (manuals as Manual[]).filter(
      (m) =>
        m.title.toLowerCase().includes(trimmed) ||
        m.tags.some((t) => t.toLowerCase().includes(trimmed))
    );
  }, [query]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl text-deep font-bold">Manuals</h1>
        <p className="text-ink/50 mt-1">Tech manuals and install guides, searchable in one place.</p>
      </div>

      <div className="relative max-w-lg">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-ink/30" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by product, SKU, or manual name"
          className="w-full rounded-full border border-ink/10 bg-white pl-11 pr-4 py-3 text-sm shadow-soft focus:border-wave focus:ring-2 focus:ring-wave/20 outline-none"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink/10 shadow-soft py-16 flex flex-col items-center gap-2">
          <BookOpen className="h-8 w-8 text-ink/20" />
          <p className="text-ink/40">No manuals matched that search.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((m) => (
            <div key={m.url} className="rounded-2xl bg-white border border-ink/10 shadow-soft p-5 flex flex-col gap-3">
              <div className="rounded-xl bg-wave/10 p-2.5 w-fit">
                <BookOpen className="h-5 w-5 text-wave" />
              </div>
              <p className="font-semibold text-ink leading-snug">{m.title}</p>
              {m.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {m.tags.map((t) => (
                    <span key={t} className="text-[11px] rounded-full bg-foam px-2 py-0.5 text-ink/50">
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <div className="flex gap-2 mt-auto pt-2">
                <a
                  href={m.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 flex items-center justify-center gap-1.5 rounded-xl border border-ink/10 px-3 py-2 text-sm font-medium hover:border-wave/30"
                >
                  <Eye className="h-4 w-4" /> View
                </a>
                <a
                  href={`${m.url}?download=1`}
                  className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-wave px-3 py-2 text-sm font-medium text-white hover:bg-deep"
                >
                  <Download className="h-4 w-4" /> Download
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
