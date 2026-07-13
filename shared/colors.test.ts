import { describe, expect, it } from 'vitest'
import { EVENT_PALETTE, isHexColor, nextPaletteColor, textColorFor } from './colors.ts'

describe('isHexColor', () => {
  it('accepts #RRGGBB', () => {
    expect(isHexColor('#4E79A7')).toBe(true)
    expect(isHexColor('#abcdef')).toBe(true)
  })

  it('rejects everything else', () => {
    expect(isHexColor('#fff')).toBe(false)
    expect(isHexColor('4E79A7')).toBe(false)
    expect(isHexColor('#4E79A7FF')).toBe(false)
    expect(isHexColor('red')).toBe(false)
    expect(isHexColor(42)).toBe(false)
    expect(isHexColor(null)).toBe(false)
  })
})

describe('nextPaletteColor', () => {
  it('starts at the first palette color', () => {
    expect(nextPaletteColor([])).toBe(EVENT_PALETTE[0])
  })

  it('skips used colors, case-insensitively', () => {
    expect(nextPaletteColor([EVENT_PALETTE[0], EVENT_PALETTE[1]!.toLowerCase()])).toBe(
      EVENT_PALETTE[2],
    )
  })

  it('ignores custom colors not in the palette', () => {
    expect(nextPaletteColor(['#123456'])).toBe(EVENT_PALETTE[0])
  })

  it('picks the least-used color when the palette is exhausted', () => {
    const used = [...EVENT_PALETTE, EVENT_PALETTE[0]]
    expect(nextPaletteColor(used)).toBe(EVENT_PALETTE[1])
  })
})

describe('textColorFor', () => {
  it('uses black text on light fills', () => {
    expect(textColorFor('#EDC948')).toBe('#000000')
    expect(textColorFor('#FFFFFF')).toBe('#000000')
    expect(textColorFor('#BAB0AC')).toBe('#000000')
  })

  it('uses white text on dark and medium fills', () => {
    expect(textColorFor('#4E79A7')).toBe('#FFFFFF')
    expect(textColorFor('#000000')).toBe('#FFFFFF')
    expect(textColorFor('#E15759')).toBe('#FFFFFF')
  })
})
