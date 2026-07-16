import { describe, expect, it } from 'vitest'
import { describeRepairChanges, repairSchedule } from './repair.ts'
import type { RepairInput } from './repair.ts'

const T = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h! * 60 + m!
}

const event = (id: number, name: string, capacity: number | null = 1, active = true) => ({
  id,
  name,
  capacity,
  active,
})

const block = (
  eventId: number,
  from: string,
  to: string,
  coachId: number | null = null,
  locked = false,
) => ({ eventId, coachId, startMin: T(from), endMin: T(to), locked })

/**
 * Two classes, each needing Vault and Beam, in their own lanes across a
 * 16:00–17:00 session. Their painted grid is passed in whole.
 */
function baseInput(overrides: Partial<RepairInput> = {}): RepairInput {
  return {
    events: [event(1, 'Vault'), event(2, 'Beam')],
    classes: [
      {
        id: 1,
        name: 'Level 3 Girls',
        priority: 0,
        requiredEvents: [
          { eventId: 1, duration: 30, position: 'ANY' as const },
          { eventId: 2, duration: 30, position: 'ANY' as const },
        ],
        assignedCoaches: [7],
      },
      {
        id: 2,
        name: 'Boys Team',
        priority: 0,
        requiredEvents: [
          { eventId: 1, duration: 30, position: 'ANY' as const },
          { eventId: 2, duration: 30, position: 'ANY' as const },
        ],
        assignedCoaches: [8],
      },
    ],
    coaches: [
      { id: 7, name: 'Dana Marsh', specialties: [1, 2] },
      { id: 8, name: 'Sam Ortiz', specialties: [1, 2] },
      { id: 9, name: 'Riley Cho', specialties: [2] },
    ],
    placements: [
      {
        id: 1,
        classId: 1,
        startMin: T('16:00'),
        endMin: T('17:00'),
        blocks: [block(1, '16:00', '16:30', 7), block(2, '16:30', '17:00', 7)],
      },
      {
        id: 2,
        classId: 2,
        startMin: T('16:00'),
        endMin: T('17:00'),
        blocks: [block(2, '16:00', '16:30', 8), block(1, '16:30', '17:00', 8)],
      },
    ],
    coachMode: 'class',
    adjacencyPenalties: [],
    absentCoachIds: [],
    unavailableEventIds: [],
    seed: 1,
    ...overrides,
  }
}

const blocksOf = (r: { placements: { placementId: number; blocks: unknown[] }[] }, id: number) =>
  r.placements.find((p) => p.placementId === id)!.blocks

describe('repair with nothing wrong', () => {
  it('changes nothing', () => {
    const result = repairSchedule(baseInput())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.changes).toEqual([])
    expect(describeRepairChanges(result.changes, baseInput() as never)).toEqual([
      'Nothing needed to change.',
    ])
  })
})

describe('repair: absent coach', () => {
  it('keeps every block where it is and only restaffs', () => {
    const before = baseInput()
    const result = repairSchedule({ ...before, absentCoachIds: [7] })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    // Nothing moved: same events at the same times.
    for (const p of before.placements) {
      expect(blocksOf(result, p.id)).toMatchObject(
        p.blocks.map((b) => ({ eventId: b.eventId, startMin: b.startMin, endMin: b.endMin })),
      )
    }
    // Dana's blocks are no longer hers.
    expect(blocksOf(result, 1).every((b) => (b as { coachId: number | null }).coachId !== 7)).toBe(
      true,
    )
    expect(result.changes.every((c) => c.kind === 'coach-reassigned')).toBe(true)
  })

  it('hands the class to a free substitute and says so', () => {
    // Riley (9) coaches Beam and is otherwise idle.
    const result = repairSchedule({ ...baseInput(), absentCoachIds: [7], coachMode: 'event' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const messages = describeRepairChanges(result.changes, {
      events: baseInput().events,
      classes: baseInput().classes,
      coaches: baseInput().coaches,
    })
    expect(messages.join(' ')).toMatch(/Dana Marsh is out/)
  })

  it('leaves the block coachless when no substitute is free, and says so', () => {
    // Only Dana exists, and she is out.
    const input = baseInput({
      coaches: [{ id: 7, name: 'Dana Marsh', specialties: [1, 2] }],
      classes: baseInput().classes.map((c) => ({ ...c, assignedCoaches: [7] })),
      placements: [
        {
          id: 1,
          classId: 1,
          startMin: T('16:00'),
          endMin: T('17:00'),
          blocks: [block(1, '16:00', '16:30', 7), block(2, '16:30', '17:00', 7)],
        },
      ],
    })
    const result = repairSchedule({ ...input, absentCoachIds: [7] })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(blocksOf(result, 1).every((b) => (b as { coachId: number | null }).coachId === null)).toBe(
      true,
    )
    const messages = describeRepairChanges(result.changes, {
      events: input.events,
      classes: input.classes,
      coaches: input.coaches,
    })
    expect(messages.join(' ')).toMatch(/currently has no coach/)
  })

  it('never double-books the substitute', () => {
    const result = repairSchedule({ ...baseInput(), absentCoachIds: [7, 8] })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // Riley only coaches Beam, and both classes are on Beam at different
    // times, so she can take both — but never two places at once.
    const perSlot = new Map<string, number>()
    for (const p of result.placements) {
      for (const b of p.blocks as { coachId: number | null; eventId: number; startMin: number; endMin: number }[]) {
        if (b.coachId === null) continue
        for (let t = b.startMin; t < b.endMin; t += 5) {
          const key = `${b.coachId}:${t}`
          const prev = perSlot.get(key)
          if (prev !== undefined) expect(prev).toBe(b.eventId)
          perSlot.set(key, b.eventId)
        }
      }
    }
  })
})

describe('repair: event out for the session', () => {
  it('removes blocks on the out event and leaves everything else in place', () => {
    const before = baseInput()
    const result = repairSchedule({ ...before, unavailableEventIds: [1] })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    // No Vault anywhere…
    for (const p of result.placements) {
      expect((p.blocks as { eventId: number }[]).some((b) => b.eventId === 1)).toBe(false)
    }
    // …and the Beam blocks never moved.
    expect(blocksOf(result, 1)).toMatchObject([{ eventId: 2, startMin: T('16:30'), endMin: T('17:00') }])
    expect(result.changes.filter((c) => c.kind === 'removed-event-out')).toHaveLength(2)
  })

  it('explains the removal as a skipped requirement', () => {
    const result = repairSchedule({ ...baseInput(), unavailableEventIds: [1] })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const messages = describeRepairChanges(result.changes, {
      events: baseInput().events,
      classes: baseInput().classes,
      coaches: baseInput().coaches,
    })
    expect(messages.join(' ')).toMatch(/Vault is out/)
    expect(messages.join(' ')).toMatch(/requirement skipped this session/)
  })
})

describe('repair: filling gaps', () => {
  it('places uncovered requirements around what is already painted', () => {
    // Level 3 only has Vault painted; Beam is missing and must be added
    // inside its own window.
    const input = baseInput({
      placements: [
        {
          id: 1,
          classId: 1,
          startMin: T('16:00'),
          endMin: T('17:00'),
          blocks: [block(1, '16:00', '16:30', 7)],
        },
      ],
      classes: [baseInput().classes[0]!],
    })
    const result = repairSchedule(input)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    const blocks = blocksOf(result, 1) as { eventId: number; startMin: number; endMin: number }[]
    expect(blocks.some((b) => b.eventId === 2)).toBe(true)
    // The original Vault block did not move.
    expect(blocks).toContainEqual(expect.objectContaining({ eventId: 1, startMin: T('16:00') }))
    // Everything stayed inside the class's window.
    for (const b of blocks) {
      expect(b.startMin).toBeGreaterThanOrEqual(T('16:00'))
      expect(b.endMin).toBeLessThanOrEqual(T('17:00'))
    }
    expect(result.changes.filter((c) => c.kind === 'added').length).toBeGreaterThan(0)
  })

  it('fails with an explanation when the class window cannot hold the rest', () => {
    const input = baseInput({
      classes: [
        {
          id: 1,
          name: 'Silver',
          priority: 0,
          requiredEvents: [{ eventId: 1, duration: 40, position: 'ANY' as const }],
          assignedCoaches: [],
        },
      ],
      placements: [
        { id: 1, classId: 1, startMin: T('16:00'), endMin: T('16:30'), blocks: [] },
      ],
    })
    const result = repairSchedule(input)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reasons.join(' ')).toMatch(/Silver/)
    expect(result.reasons.join(' ')).toMatch(/window is only 30 min/)
  })
})
