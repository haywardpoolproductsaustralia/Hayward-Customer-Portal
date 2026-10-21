// lib/containers/pdf-layout.ts
// Layout-preserving PDF text (like `pdftotext -layout`): groups pdf.js text items into rows by y,
// orders by x, and pads gaps with spaces sized by the glyph width — so column regexes work.
//
// Uses pdfjs-dist's legacy (Node) build. pdf-parse 1.1.1 bundles a 2017 pdf.js that rejects the
// Wuxi packing slips ("bad XRef entry"); pdfjs-dist 4.x opens them fine.
// next.config.js must list "pdfjs-dist" in serverComponentsExternalPackages.

interface TextItem { str: string; transform: number[]; width: number }

let pdfjsPromise: Promise<any> | null = null;
function pdfjs() {
  // Dynamic import keeps the ESM build out of Next's bundler; evaluated once per lambda.
  if (!pdfjsPromise) pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

function renderRows(items: TextItem[]): string {
  const rows = new Map<number, TextItem[]>();
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const y = Math.round(it.transform[5] / 2) * 2; // 2pt buckets
    (rows.get(y) ?? rows.set(y, []).get(y)!).push(it);
  }
  const out: string[] = [];
  for (const y of [...rows.keys()].sort((a, b) => b - a)) {
    const line = rows.get(y)!.sort((a, b) => a.transform[4] - b.transform[4]);
    let s = "";
    let cursorX: number | null = null;
    for (const it of line) {
      const x = it.transform[4];
      const cw = it.width > 0 && it.str.length ? it.width / it.str.length : 5;
      if (cursorX == null) {
        s += " ".repeat(Math.max(0, Math.round(x / cw)));
      } else {
        const gap = x - cursorX;
        const n = gap < 0.35 * cw ? 0 : Math.max(1, Math.round(gap / cw));
        s += " ".repeat(n);
      }
      s += it.str;
      cursorX = x + it.width;
    }
    out.push(s.replace(/\s+$/, ""));
  }
  return out.join("\n");
}

/** Returns one layout-preserved string per page. */
export async function pdfLayoutText(buf: Buffer | Uint8Array): Promise<string[]> {
  const lib = await pdfjs();
  const data = buf instanceof Uint8Array ? new Uint8Array(buf) : new Uint8Array(buf);
  const doc = await lib.getDocument({ data, disableFontFace: true, isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  const pages: string[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      pages.push(renderRows(tc.items as TextItem[]));
    }
  } finally {
    await doc.destroy().catch(() => {});
  }
  return pages;
}
