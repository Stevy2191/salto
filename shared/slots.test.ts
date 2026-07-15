import { describe, expect, it } from 'vitest'
import {
  SLOT_MINUTES,
  formatRange,
  formatTime,
  isSnapped,
  overlaps,
  parseTime,
  rowCount,
  rowIndexOf,
  rowLabel,
  rowStartMin,
  sessionWindow,
  snap,
} from './slots.ts'

const session = { startTime: '16:00', endTime: '20:00' }

describe('parseTime', () => {
  it('parses valid times', () => {
    expect(parseTime('00:00')).toBe(0)
    expect(parseTime('16:30')).toBe(990)
    expect(parseTime('23:59')).toBe(1439)
  })

  it('rejects malformed input', () => {
    for (const bad of ['4pm', '16:60', '24:00', '1:00', '', '16-00']) {
      expect(parseTime(bad)).toBeNull()
    }
  })
})

describe('formatTime', () => {
  it('round-trips with parseTime', () => {
    for (const t of ['00:00', '09:05', '16:30', '23:55']) {
      expect(formatTime(parseTime(t)!)).toBe(t)
    }
  })
})

describe('snapping', () => {
  it('snaps to the nearest 5 minutes', () => {
    expect(snap(0)).toBe(0)
    expect(snap(62)).toBe(60)
    expect(snap(63)).toBe(65)
    expect(snap(967)).toBe(965)
  })

  it('recognizes already-snapped values', () => {
    expect(isSnapped(960)).toBe(true)
    expect(isSnapped(962)).toBe(false)
    expect(isSnapped(1.5)).toBe(false)
  })

  it('agrees with SLOT_MINUTES', () => {
    expect(SLOT_MINUTES).toBe(5)
    expect(snap(SLOT_MINUTES * 3)).toBe(SLOT_MINUTES * 3)
  })
})

describe('the time axis', () => {
  it('counts 5-minute rows across the session window', () => {
    expect(rowCount(session)).toBe(48) // 4 hours
    expect(rowCount({ startTime: '16:00', endTime: '16:05' })).toBe(1)
  })

  it('is empty for a zero-length or backwards window', () => {
    expect(rowCount({ startTime: '16:00', endTime: '16:00' })).toBe(0)
    expect(rowCount({ startTime: '18:00', endTime: '16:00' })).toBe(0)
  })

  it('maps rows to clock times and back', () => {
    expect(rowStartMin(session, 0)).toBe(parseTime('16:00'))
    expect(rowLabel(session, 0)).toBe('16:00')
    expect(rowLabel(session, 6)).toBe('16:30')
    expect(rowLabel(session, 47)).toBe('19:55')
    expect(rowIndexOf(session, parseTime('16:30')!)).toBe(6)
    expect(rowIndexOf(session, parseTime('16:34')!)).toBe(6) // mid-row
    expect(rowIndexOf(session, parseTime('16:35')!)).toBe(7)
  })

  it('exposes the window as minutes', () => {
    expect(sessionWindow(session)).toEqual({ startMin: 960, endMin: 1200 })
  })
})

describe('overlaps', () => {
  it('is true when spans share time', () => {
    expect(overlaps(0, 10, 5, 15)).toBe(true)
    expect(overlaps(5, 15, 0, 10)).toBe(true)
    expect(overlaps(0, 30, 10, 20)).toBe(true) // contained
  })

  it('is false when spans only touch — back-to-back classes are legal', () => {
    expect(overlaps(0, 10, 10, 20)).toBe(false)
    expect(overlaps(10, 20, 0, 10)).toBe(false)
  })

  it('is false when spans are apart', () => {
    expect(overlaps(0, 10, 20, 30)).toBe(false)
  })
})

describe('formatRange', () => {
  it('reads a window back the way a coach says it', () => {
    expect(formatRange(960, 1020)).toBe('16:00–17:00')
  })
})
