import { describe, expect, it } from 'vitest'
import type { EventBlock, GymEvent, Placement, Schedule } from '../../shared/types.ts'
import { findConflicts } from './conflicts.ts'

const event = (id: number, shared = false, active = true): GymEvent => ({
  id,
  name: `Event ${id}`,
  shared,
  active,
  color: '#4E79A7',
  isSample: false,
})

let nextId = 1
const block = (
  eventId: number,
  startMin: number,
  endMin: number,
  coachId: number | null = null,
): EventBlock => ({ id: nextId++, eventId, coachId, startMin, endMin, locked: false })

const placement = (
  classId: number,
  columnIndex: number,
  startMin: number,
  endMin: number,
  blocks: EventBlock[] = [],
): Placement => ({ id: nextId++, classId, columnIndex, week: 1, startMin, endMin, blocks })

const schedule = (placements: Placement[]): Schedule => ({ placements })

describe('lane rules', () => {
  it('accepts classes stacked back to back in one column', () => {
    const found = findConflicts(
      schedule([placement(1, 0, 960, 1020), placement(2, 0, 1020, 1080)]),
      [event(1)],
    )
    expect(found.count).toBe(0)
  })

  it('flags two classes overlapping in the same column', () => {
    const a = placement(1, 0, 960, 1020)
    const b = placement(2, 0, 1000, 1080)
    const found = findConflicts(schedule([a, b]), [event(1)])
    expect(found.placements.get(a.id)).toContain('column-overlap')
    expect(found.placements.get(b.id)).toContain('column-overlap')
  })

  it('allows the same overlap across different columns', () => {
    const found = findConflicts(
      schedule([placement(1, 0, 960, 1020), placement(2, 1, 1000, 1080)]),
      [event(1)],
    )
    expect(found.count).toBe(0)
  })

  it('flags one class placed in two columns at overlapping times', () => {
    const a = placement(7, 0, 960, 1020)
    const b = placement(7, 1, 1000, 1080)
    const found = findConflicts(schedule([a, b]), [event(1)])
    expect(found.placements.get(a.id)).toContain('class-double-booked')
    expect(found.placements.get(b.id)).toContain('class-double-booked')
  })

  it('lets one class appear twice in a session at different times', () => {
    const found = findConflicts(
      schedule([placement(7, 0, 960, 1020), placement(7, 1, 1020, 1080)]),
      [event(1)],
    )
    expect(found.count).toBe(0)
  })
})

describe('coaches', () => {
  it('flags a coach on two events at the same moment', () => {
    const one = block(1, 960, 1020, 7)
    const two = block(2, 1000, 1080, 7)
    const found = findConflicts(
      schedule([placement(1, 0, 960, 1080, [one]), placement(2, 1, 960, 1080, [two])]),
      [event(1), event(2)],
    )
    expect(found.blocks.get(one.id)).toContain('coach-double-booked')
    expect(found.blocks.get(two.id)).toContain('coach-double-booked')
  })

  it('allows one coach running two classes at the same event — one station', () => {
    const one = block(1, 960, 1020, 7)
    const two = block(1, 960, 1020, 7)
    // A shared event, so the two classes on it don't trip the exclusive-event
    // rule — this isolates the coach "one station" rule.
    const found = findConflicts(
      schedule([placement(1, 0, 960, 1080, [one]), placement(2, 1, 960, 1080, [two])]),
      [event(1, true)],
    )
    expect(found.count).toBe(0)
  })

  it('allows a coach back to back on different events', () => {
    const one = block(1, 960, 1020, 7)
    const two = block(2, 1020, 1080, 7)
    const found = findConflicts(
      schedule([placement(1, 0, 960, 1080, [one]), placement(2, 1, 960, 1080, [two])]),
      [event(1), event(2)],
    )
    expect(found.count).toBe(0)
  })

  it('ignores unstaffed blocks', () => {
    const found = findConflicts(
      schedule([
        placement(1, 0, 960, 1080, [block(1, 960, 1020)]),
        placement(2, 1, 960, 1080, [block(2, 960, 1020)]),
      ]),
      [event(1), event(2)],
    )
    expect(found.count).toBe(0)
  })
})

describe('exclusive event collisions', () => {
  it('flags two classes on an exclusive event at the same time', () => {
    const one = block(1, 960, 1020)
    const two = block(1, 1000, 1080)
    const found = findConflicts(
      schedule([placement(1, 0, 960, 1080, [one]), placement(2, 1, 960, 1080, [two])]),
      [event(1)],
    )
    expect(found.blocks.get(one.id)).toContain('event-double-booked')
    expect(found.blocks.get(two.id)).toContain('event-double-booked')
  })

  it('never flags a shared event, however many classes are on it', () => {
    const found = findConflicts(
      schedule([
        placement(1, 0, 960, 1080, [block(1, 960, 1020)]),
        placement(2, 1, 960, 1080, [block(1, 960, 1020)]),
        placement(3, 2, 960, 1080, [block(1, 960, 1020)]),
      ]),
      [event(1, true)],
    )
    expect(found.count).toBe(0)
  })

  it('does not flag classes that merely share an exclusive event at different times', () => {
    const found = findConflicts(
      schedule([
        placement(1, 0, 960, 1080, [block(1, 960, 1020)]),
        placement(2, 1, 960, 1080, [block(1, 1020, 1080)]),
      ]),
      [event(1)],
    )
    expect(found.count).toBe(0)
  })
})

describe('inactive events', () => {
  it('flags a block on an inactive event', () => {
    const one = block(1, 960, 1020)
    const found = findConflicts(schedule([placement(1, 0, 960, 1080, [one])]), [
      event(1, false, false),
    ])
    expect(found.blocks.get(one.id)).toContain('event-inactive')
  })

  it('flags a block on a deleted (unknown) event', () => {
    const one = block(99, 960, 1020)
    const found = findConflicts(schedule([placement(1, 0, 960, 1080, [one])]), [event(1)])
    expect(found.blocks.get(one.id)).toContain('event-inactive')
  })
})

describe('multiple reasons', () => {
  it('accumulates every reason on one block', () => {
    const one = block(1, 960, 1020, 7)
    const two = block(2, 960, 1020, 7)
    const three = block(1, 960, 1020)
    const found = findConflicts(
      schedule([
        placement(1, 0, 960, 1080, [one]),
        placement(2, 1, 960, 1080, [two]),
        placement(3, 2, 960, 1080, [three]),
      ]),
      [event(1, false, false), event(2)],
    )
    const reasons = found.blocks.get(one.id)!
    expect(reasons).toContain('event-inactive')
    expect(reasons).toContain('event-double-booked')
    expect(reasons).toContain('coach-double-booked')
  })
})
