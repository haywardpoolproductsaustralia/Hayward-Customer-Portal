const GROUPS: { label: string; test: (n: string) => boolean }[] = [
  { label: "Reece Group",  test: n => n.startsWith("REECE") },
  { label: "Pool Systems", test: n => n.startsWith("POOL SYSTEMS") },
  { label: "Poolwerx",     test: n => n.startsWith("POOLWERX") },
];

// Header a branch belongs under, or null if it stands on its own.
export function customerGroup(name?: string | null): string | null {
  if (!name) return null;
  const n = name.trim().toUpperCase();
  return GROUPS.find(g => g.test(n))?.label ?? null;
}

export type CustomerOption = { value: string; label: string };
export type OptionSection = { group: string | null; options: CustomerOption[] };

// Keeps every branch selectable; just buckets them under headers.
export function groupCustomerOptions(options: CustomerOption[]): OptionSection[] {
  const sections = new Map<string, CustomerOption[]>();
  const standalone: CustomerOption[] = [];
  for (const opt of options) {
    const g = customerGroup(opt.label);
    if (g) (sections.get(g) ?? sections.set(g, []).get(g)!).push(opt);
    else standalone.push(opt);
  }
  const by = (a: CustomerOption, b: CustomerOption) => a.label.localeCompare(b.label);
  const grouped = [...sections.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([group, opts]) => ({ group, options: opts.sort(by) }));
  return standalone.length
    ? [...grouped, { group: null, options: standalone.sort(by) }]
    : grouped;
}
