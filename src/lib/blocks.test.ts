import { describe, expect, it } from 'vitest'
import { classBlocks } from './blocks.ts'
import type { Assignment } from '../../shared/types.ts'

const a = (
  slotIndex: number,
  eventId: number,
  classId = 1,
  coachId: number | null = null,
): Assignment => ({ slotIndex, eventId, classId, coachId })

describe('classBlocks', () => {
  it('merges consecutive same-event same-coach slots', () => {
    expect(classBlocks([a(0, 1, 1, 7), a(1, 1, 1, 7), a(2, 2)], 1, 4)).toEqual([
      { startSlot: 0, length: 2, eventId: 1, coachId: 7 },
      { startSlot: 2, length: 1, eventId: 2, coachId: null },
    ])
  })

  it('splits on coach change and on gaps', () => {
    expect(classBlocks([a(0, 1, 1, 7), a(1, 1, 1, 8), a(3, 1, 1, 8)], 1, 5)).toEqual([
      { startSlot: 0, length: 1, eventId: 1, coachId: 7 },
      { startSlot: 1, length: 1, eventId: 1, coachId: 8 },
      { startSlot: 3, length: 1, eventId: 1, coachId: 8 },
    ])
  })

  it('only considers the requested class', () => {
    expect(classBlocks([a(0, 1, 1), a(0, 2, 2), a(1, 2, 2)], 2, 3)).toEqual([
      { startSlot: 0, length: 2, eventId: 2, coachId: null },
    ])
  })

  it('returns nothing for an empty timeline', () => {
    expect(classBlocks([], 1, 8)).toEqual([])
  })
})
