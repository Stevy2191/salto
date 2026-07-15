// Deterministic per-class chip colors so the grid reads at a glance.
// Full literal class strings so Tailwind's scanner picks them up — it reads
// source text, so these can never be assembled from parts.

const PALETTE = [
  'bg-sky-100 text-sky-900 ring-sky-300 dark:bg-sky-950 dark:text-sky-100 dark:ring-sky-700',
  'bg-emerald-100 text-emerald-900 ring-emerald-300 dark:bg-emerald-950 dark:text-emerald-100 dark:ring-emerald-700',
  'bg-violet-100 text-violet-900 ring-violet-300 dark:bg-violet-950 dark:text-violet-100 dark:ring-violet-700',
  'bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-700',
  'bg-rose-100 text-rose-900 ring-rose-300 dark:bg-rose-950 dark:text-rose-100 dark:ring-rose-700',
  'bg-teal-100 text-teal-900 ring-teal-300 dark:bg-teal-950 dark:text-teal-100 dark:ring-teal-700',
  'bg-fuchsia-100 text-fuchsia-900 ring-fuchsia-300 dark:bg-fuchsia-950 dark:text-fuchsia-100 dark:ring-fuchsia-700',
  'bg-lime-100 text-lime-900 ring-lime-300 dark:bg-lime-950 dark:text-lime-100 dark:ring-lime-700',
  'bg-cyan-100 text-cyan-900 ring-cyan-300 dark:bg-cyan-950 dark:text-cyan-100 dark:ring-cyan-700',
  'bg-orange-100 text-orange-900 ring-orange-300 dark:bg-orange-950 dark:text-orange-100 dark:ring-orange-700',
] as const

export function classColor(classId: number): string {
  return PALETTE[classId % PALETTE.length]!
}
