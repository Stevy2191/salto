import { describe, expect, it } from 'vitest'
import { generateSchedule } from './solver.ts'
import { describeRepairChanges, repairSchedule } from './repair.ts'
import type { RepairInput } from './repair.ts'
import type { SolverInput } from './types.ts'

const event = (id: number, name: string, capacity = 1, active = true) => ({
  id,
  name,
  capacity,
  active,
})

function baseInput(overrides: Partial<SolverInput>): SolverInput {
  return {
    events: [event(1, 'Vault'), event(2, 'Beam')],
    classes: [
      {
        id: 1,
        name: 'Level 3 Girls',
        priority: 0,
        requiredEvents: [
          { eventId: 1, duration: 30 },
          { eventId: 2, duration: 30 },
        ],
        assignedCoaches: [7],
      },
      {
        id: 2,
        name: 'Boys Team',
        priority: 0,
        requiredEvents: [
          { eventId: 1, duration: 30 },
          { eventId: 2, duration: 30 },
        ],
        assignedCoaches: [8],
      },
    ],
    coaches: [
      { id: 7, name: 'Dana Marsh', specialties: [1, 2] },
      { id: 8, name: 'Sam Ortiz', specialties: [1, 2] },
      { id: 9, name: 'Riley Cho', specialties: [2] },
    ],
    slotCount: 4,
    rotationLength: 15,
    coachMode: 'class',
    adjacencyPenalties: [],
    locked: [],
    seed: 1,
    ...overrides,
  }
}

function repairInput(
  base: SolverInput,
  overrides: Partial<RepairInput>,
): RepairInput {
  const { locked: _locked, ...rest } = base
  return {
    ...rest,
    original: [],
    absentCoachIds: [],
    unavailableEventIds: [],
    ...overrides,
  }
}

function generated(base: SolverInput) {
  const result = generateSchedule(base)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('unreachable')
  return result.assignments
}

describe('repair: absent coach', () => {
  it('keeps every placement and restaffs with a free coach', () => {
    const base = baseInput({})
    const original = generated(base)
    const result = repairSchedule(repairInput(base, { original, absentCoachIds: [7] }))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    // Same cells, exactly — only coaches may differ.
    const cells = (list: typeof original) =>
      list.map((a) => `${a.slotIndex}:${a.eventId}:${a.classId}`).sort()
    expect(cells(result.assignments)).toEqual(cells(original))
    expect(result.assignments.every((a) => a.coachId !== 7)).toBe(true)

    // Every cell that had Dana got a reassignment change entry.
    const affected = original.filter((a) => a.coachId === 7)
    expect(affected.length).toBeGreaterThan(0)
    const reassignments = result.changes.filter((c) => c.kind === 'coach-reassigned')
    expect(reassignments).toHaveLength(affected.length)
  })

  it('leaves the cell coachless when no substitute is free, and says so', () => {
    const base = baseInput({
      coaches: [{ id: 7, name: 'Dana Marsh', specialties: [1, 2] }],
      classes: baseInput({}).classes.map((g) => ({ ...g, assignedCoaches: [7] })),
    })
    const original = generated(base)
    const result = repairSchedule(repairInput(base, { original, absentCoachIds: [7] }))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.assignments.every((a) => a.coachId === null)).toBe(true)

    const messages = describeRepairChanges(result.changes, {
      events: base.events,
      classes: base.classes,
      coaches: base.coaches,
      startTime: '16:00',
      rotationLength: 15,
    })
    expect(messages.join(' ')).toContain('Dana Marsh is out')
    expect(messages.join(' ')).toContain('currently has no coach')
  })

  it('untouched assignments keep their original coach', () => {
    const base = baseInput({})
    const original = generated(base)
    const result = repairSchedule(repairInput(base, { original, absentCoachIds: [7] }))
    if (!result.ok) throw new Error('expected ok')
    for (const a of original) {
      if (a.coachId === 7) continue
      const kept = result.assignments.find(
        (x) => x.slotIndex === a.slotIndex && x.eventId === a.eventId && x.classId === a.classId,
      )
      expect(kept).toEqual(a)
    }
  })
})

describe('repair: event out for the session', () => {
  it('removes blocks on the out event and leaves everything else in place', () => {
    const base = baseInput({})
    const original = generated(base)
    const result = repairSchedule(repairInput(base, { original, unavailableEventIds: [2] }))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    expect(result.assignments.every((a) => a.eventId !== 2)).toBe(true)
    const survivors = original.filter((a) => a.eventId !== 2)
    expect(result.assignments).toHaveLength(survivors.length)
    for (const a of survivors) {
      expect(result.assignments).toContainEqual(a)
    }

    const messages = describeRepairChanges(result.changes, {
      events: base.events,
      classes: base.classes,
      coaches: base.coaches,
      startTime: '16:00',
      rotationLength: 15,
    })
    expect(messages.join(' ')).toContain('Beam is out')
    expect(messages.join(' ')).toContain('requirement skipped this session')
  })

  it('preserves user locks through a repair', () => {
    const base = baseInput({})
    const original = generated(base).map((a, i) => ({ ...a, locked: i === 0 }))
    const result = repairSchedule(repairInput(base, { original, absentCoachIds: [7] }))
    if (!result.ok) throw new Error('expected ok')
    const lockedCells = result.assignments.filter((a) => a.locked)
    const originalLocked = original.filter((a) => a.locked && a.eventId !== 0)
    expect(lockedCells.map((a) => `${a.slotIndex}:${a.eventId}:${a.classId}`)).toEqual(
      originalLocked.map((a) => `${a.slotIndex}:${a.eventId}:${a.classId}`),
    )
  })
})

describe('repair: filling uncovered requirements', () => {
  it('places requirements the original schedule was missing', () => {
    const base = baseInput({})
    // Original only covers class 1's vault — everything else is missing.
    const original = [
      { slotIndex: 0, eventId: 1, classId: 1, coachId: 7 },
      { slotIndex: 1, eventId: 1, classId: 1, coachId: 7 },
    ]
    const result = repairSchedule(repairInput(base, { original }))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // Original cells untouched…
    for (const a of original) {
      expect(result.assignments).toContainEqual({ ...a, locked: false })
    }
    // …and each class now has its full 4 slots of requirements.
    for (const classId of [1, 2]) {
      expect(result.assignments.filter((a) => a.classId === classId)).toHaveLength(4)
    }
    expect(result.changes.some((c) => c.kind === 'added')).toBe(true)
  })

  it('explains impossibility in plain language', () => {
    const base = baseInput({})
    // Class 2's beam requirement is uncovered, but class 1 holds beam for
    // slots 0–1 and vault demand fills the rest — session too tight after
    // shrinking to 2 slots.
    const tight = { ...base, slotCount: 2 }
    const original = [
      { slotIndex: 0, eventId: 2, classId: 1, coachId: null },
      { slotIndex: 1, eventId: 2, classId: 1, coachId: null },
    ]
    const result = repairSchedule(repairInput(tight, { original }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reasons.length).toBeGreaterThan(0)
    expect(result.reasons.every((r) => r.length > 10)).toBe(true)
  })
})

describe('repair determinism', () => {
  it('same input and seed produce the same repair', () => {
    const base = baseInput({})
    const original = generated(base)
    const input = repairInput(base, { original, absentCoachIds: [7], unavailableEventIds: [2] })
    expect(repairSchedule(input)).toEqual(repairSchedule(input))
  })
})
