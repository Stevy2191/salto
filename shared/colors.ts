// Event color palette and helpers, shared by the server (seed, migrations,
// Excel export) and the frontend (picker, grid).

/**
 * Curated palette (Tableau 10): visually distinct, print-friendly,
 * reasonable under common color-vision deficiencies.
 */
export const EVENT_PALETTE = [
  '#4E79A7', // steel blue
  '#F28E2B', // orange
  '#59A14F', // green
  '#E15759', // red
  '#B07AA1', // purple
  '#76B7B2', // teal
  '#EDC948', // yellow
  '#FF9DA7', // pink
  '#9C755F', // brown
  '#BAB0AC', // gray
] as const

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value)
}

/** First palette color not yet used; when all are used, the least-used one. */
export function nextPaletteColor(used: string[]): string {
  const normalized = used.map((c) => c.toUpperCase())
  for (const color of EVENT_PALETTE) {
    if (!normalized.includes(color)) return color
  }
  let best: string = EVENT_PALETTE[0]
  let bestCount = Infinity
  for (const color of EVENT_PALETTE) {
    const count = normalized.filter((c) => c === color).length
    if (count < bestCount) {
      best = color
      bestCount = count
    }
  }
  return best
}

/**
 * Black or white text for readable contrast on the given background.
 * Perceived brightness via the YIQ formula; the 150 threshold prefers
 * white text on medium-brightness fills, which prints better.
 */
export function textColorFor(bgHex: string): '#000000' | '#FFFFFF' {
  const r = parseInt(bgHex.slice(1, 3), 16)
  const g = parseInt(bgHex.slice(3, 5), 16)
  const b = parseInt(bgHex.slice(5, 7), 16)
  const brightness = (r * 299 + g * 587 + b * 114) / 1000
  return brightness >= 150 ? '#000000' : '#FFFFFF'
}
