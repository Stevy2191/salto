import { describe, expect, it } from 'vitest'
import type { Assignment, GymEvent } from '../../shared/types.ts'
import { assignmentKey, findConflicts } from './conflicts.ts'

const event = (id: number, capacity = 1, active = true): GymEvent => ({
  id,
  name: `Event ${id}`,
  capacity,
  active,
  color: '#4E79A7',
  isSample: false,
})

const a = (
  slotIndex: number,
  eventId: number,
  classId: number,
  coachId: number | null = null,
): Assignment => ({ slotIndex, eventId, classId, coachId })

describe('findConflicts', () => {
  it('returns empty for a clean schedule', () => {
    const conflicts = findConflicts(
      [a(0, 1, 1, 1), a(0, 2, 2, 2), a(1, 1, 2, 2), a(1, 2, 1, 1)],
      [event(1), event(2)],
    )
    expect(conflicts.size).toBe(0)
  })

  it('flags a class booked on two events in the same slot', () => {
    const one = a(0, 1, 1)
    const two = a(0, 2, 1)
    const conflicts = findConflicts([one, two], [event(1), event(2)])
    expect(conflicts.get(assignmentKey(one))).toContain('class-double-booked')
    expect(conflicts.get(assignmentKey(two))).toContain('class-double-booked')
  })

  it('does not flag the same class in the same slot across different slots', () => {
    const conflicts = findConflicts([a(0, 1, 1), a(1, 2, 1)], [event(1), event(2)])
    expect(conflicts.size).toBe(0)
  })

  it('flags a coach on two events in the same slot', () => {
    const one = a(0, 1, 1, 7)
    const two = a(0, 2, 2, 7)
    const conflicts = findConflicts([one, two], [event(1), event(2)])
    expect(conflicts.get(assignmentKey(one))).toContain('coach-double-booked')
    expect(conflicts.get(assignmentKey(two))).toContain('coach-double-booked')
  })

  it('allows one coach with two classes at the same event', () => {
    const conflicts = findConflicts(
      [a(0, 1, 1, 7), a(0, 1, 2, 7)],
      [event(1, 2)],
    )
    expect(conflicts.size).toBe(0)
  })

  it('ignores unassigned coaches', () => {
    const conflicts = findConflicts(
      [a(0, 1, 1, null), a(0, 2, 2, null)],
      [event(1), event(2)],
    )
    expect(conflicts.size).toBe(0)
  })

  it('flags an event over capacity', () => {
    const one = a(0, 1, 1)
    const two = a(0, 1, 2)
    const conflicts = findConflicts([one, two], [event(1, 1)])
    expect(conflicts.get(assignmentKey(one))).toContain('over-capacity')
    expect(conflicts.get(assignmentKey(two))).toContain('over-capacity')
  })

  it('respects capacity greater than one', () => {
    const conflicts = findConflicts([a(0, 1, 1), a(0, 1, 2)], [event(1, 2)])
    expect(conflicts.size).toBe(0)
  })

  it('flags assignments on an inactive event', () => {
    const one = a(0, 1, 1)
    const conflicts = findConflicts([one], [event(1, 1, false)])
    expect(conflicts.get(assignmentKey(one))).toContain('event-inactive')
  })

  it('flags assignments on a deleted (unknown) event', () => {
    const one = a(0, 99, 1)
    const conflicts = findConflicts([one], [event(1)])
    expect(conflicts.get(assignmentKey(one))).toContain('event-inactive')
  })

  it('accumulates multiple reasons on one assignment', () => {
    const one = a(0, 1, 1)
    const two = a(0, 1, 2)
    const three = a(0, 2, 1)
    const conflicts = findConflicts([one, two, three], [event(1, 1, false), event(2)])
    const reasons = conflicts.get(assignmentKey(one))!
    expect(reasons).toContain('over-capacity')
    expect(reasons).toContain('event-inactive')
    expect(reasons).toContain('class-double-booked')
  })
})
