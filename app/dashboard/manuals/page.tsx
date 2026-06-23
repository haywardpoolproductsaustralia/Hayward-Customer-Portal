import { BookOpen } from 'lucide-react';

export default function ManualsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl text-deep font-bold">Manuals</h1>
        <p className="text-ink/50 mt-1">Tech manuals and install guides, in one place.</p>
      </div>

      <div className="rounded-2xl bg-white border border-ink/10 shadow-soft py-20 flex flex-col items-center gap-3">
        <div className="rounded-full bg-wave/10 p-4">
          <BookOpen className="h-7 w-7 text-wave" />
        </div>
        <p className="font-medium text-ink">Coming soon</p>
        <p className="text-sm text-ink/40 max-w-sm text-center">
          This section will hold every Hayward tech manual and install guide,
          searchable in one spot.
        </p>
      </div>
    </div>
  );
}
