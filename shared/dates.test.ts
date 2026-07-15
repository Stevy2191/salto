import { describe, expect, it } from 'vitest'
import {
  addDays,
  dayOfWeekOf,
  formatDateLong,
  formatDateShort,
  isIsoDate,
  parseIsoDate,
  todayIsoDate,
} from './dates.ts'

describe('parseIsoDate / isIsoDate', () => {
  it('accepts real calendar dates', () => {
    expect(isIsoDate('2026-03-03')).toBe(true)
    expect(isIsoDate('2024-02-29')).toBe(true) // leap day
  })

  it('rejects malformed strings', () => {
    for (const bad of ['2026-3-3', '03/03/2026', '2026-03-03T00:00', '', 'Monday']) {
      expect(isIsoDate(bad)).toBe(false)
    }
  })

  it('rejects dates that do not exist', () => {
    expect(isIsoDate('2026-02-31')).toBe(false)
    expect(isIsoDate('2025-02-29')).toBe(false) // not a leap year
    expect(isIsoDate('2026-13-01')).toBe(false)
  })

  it('parses to UTC midnight', () => {
    expect(parseIsoDate('2026-03-03')!.toISOString()).toBe('2026-03-03T00:00:00.000Z')
  })
})

describe('dayOfWeekOf', () => {
  it('matches the calendar', () => {
    expect(dayOfWeekOf('2026-03-01')).toBe(0) // Sunday
    expect(dayOfWeekOf('2026-03-02')).toBe(1) // Monday
    expect(dayOfWeekOf('2026-03-07')).toBe(6) // Saturday
  })
})

describe('addDays', () => {
  it('adds across month and year boundaries', () => {
    expect(addDays('2026-03-03', 7)).toBe('2026-03-10')
    expect(addDays('2026-12-29', 7)).toBe('2027-01-05')
    expect(addDays('2026-03-03', -7)).toBe('2026-02-24')
  })
})

describe('formatting', () => {
  it('formats the long form', () => {
    expect(formatDateLong('2026-03-03')).toBe('Tuesday, March 3, 2026')
  })

  it('formats the short form', () => {
    expect(formatDateShort('2026-03-03')).toBe('Tue Mar 3')
  })
})

describe('todayIsoDate', () => {
  it('uses the local calendar day', () => {
    const now = new Date(2026, 2, 3, 23, 30) // local Mar 3, late evening
    expect(todayIsoDate(now)).toBe('2026-03-03')
  })
})
