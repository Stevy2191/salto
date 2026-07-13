import { describe, expect, it } from 'vitest'
import { formatTime, parseTime, slotCount, slotStart } from './slots.ts'

describe('parseTime', () => {
  it('parses valid times', () => {
    expect(parseTime('00:00')).toBe(0)
    expect(parseTime('16:30')).toBe(990)
    expect(parseTime('23:59')).toBe(1439)
  })

  it('rejects malformed input', () => {
    expect(parseTime('4pm')).toBeNull()
    expect(parseTime('24:00')).toBeNull()
    expect(parseTime('12:60')).toBeNull()
    expect(parseTime('9:00')).toBeNull()
    expect(parseTime('')).toBeNull()
  })
})

describe('formatTime', () => {
  it('round-trips with parseTime', () => {
    expect(formatTime(parseTime('16:45')!)).toBe('16:45')
    expect(formatTime(parseTime('09:05')!)).toBe('09:05')
  })
})

describe('slotCount', () => {
  it('counts whole slots in the window', () => {
    expect(slotCount({ startTime: '16:00', endTime: '18:00', rotationLength: 15 })).toBe(8)
    expect(slotCount({ startTime: '16:00', endTime: '18:30', rotationLength: 15 })).toBe(10)
  })

  it('handles any 5-minute rotation length', () => {
    expect(slotCount({ startTime: '16:00', endTime: '18:05', rotationLength: 25 })).toBe(5)
    expect(slotCount({ startTime: '16:00', endTime: '17:00', rotationLength: 5 })).toBe(12)
    expect(slotCount({ startTime: '16:00', endTime: '18:00', rotationLength: 20 })).toBe(6)
  })

  it('drops a trailing partial slot', () => {
    expect(slotCount({ startTime: '16:00', endTime: '18:10', rotationLength: 15 })).toBe(8)
  })

  it('returns 0 for degenerate windows', () => {
    expect(slotCount({ startTime: '18:00', endTime: '16:00', rotationLength: 15 })).toBe(0)
    expect(slotCount({ startTime: '16:00', endTime: '16:00', rotationLength: 15 })).toBe(0)
    expect(slotCount({ startTime: 'bad', endTime: '16:00', rotationLength: 15 })).toBe(0)
  })
})

describe('slotStart', () => {
  it('labels slots by their start time', () => {
    const session = { startTime: '16:00', rotationLength: 15 }
    expect(slotStart(session, 0)).toBe('16:00')
    expect(slotStart(session, 2)).toBe('16:30')
    expect(slotStart(session, 9)).toBe('18:15')
  })

  it('labels slots for non-15-minute rotations', () => {
    expect(slotStart({ startTime: '16:00', rotationLength: 25 }, 3)).toBe('17:15')
    expect(slotStart({ startTime: '09:30', rotationLength: 5 }, 4)).toBe('09:50')
  })
})
