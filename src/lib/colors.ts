// Deterministic per-group chip colors so the grid reads at a glance.
// Full literal class strings so Tailwind's scanner picks them up.

const PALETTE = [
  'bg-sky-100 text-sky-900 ring-sky-300',
  'bg-emerald-100 text-emerald-900 ring-emerald-300',
  'bg-violet-100 text-violet-900 ring-violet-300',
  'bg-amber-100 text-amber-900 ring-amber-300',
  'bg-rose-100 text-rose-900 ring-rose-300',
  'bg-teal-100 text-teal-900 ring-teal-300',
  'bg-fuchsia-100 text-fuchsia-900 ring-fuchsia-300',
  'bg-lime-100 text-lime-900 ring-lime-300',
  'bg-cyan-100 text-cyan-900 ring-cyan-300',
  'bg-orange-100 text-orange-900 ring-orange-300',
] as const

export function groupColor(groupId: number): string {
  return PALETTE[groupId % PALETTE.length]!
}
