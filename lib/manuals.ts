import manualsData from '@/config/manuals.json';

export interface Manual {
  title: string;
  url: string;
  tags: string[];
}

/**
 * Finds manuals relevant to a free-text query by simple keyword overlap
 * against title + tags. Good enough for a "bunch of manuals that don't
 * change much" - if the library grows into the hundreds, this is the
 * first thing worth upgrading to real embeddings-based search.
 */
export function findRelevantManuals(query: string, limit = 2): Manual[] {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  if (words.length === 0) return [];

  const all = manualsData as Manual[];
  const scored = all.map((m) => {
    const haystack = `${m.title} ${m.tags.join(' ')}`.toLowerCase();
    const score = words.filter((w) => haystack.includes(w)).length;
    return { manual: m, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.manual);
}
