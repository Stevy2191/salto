import { describe, expect, it } from 'vitest'
import { generateSchedule } from './solver.ts'
import { hardConstraintViolations } from './validate.ts'
import type { SolverBlock, SolverInput, SolverPlacement } from './types.ts'

const T = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h! * 60 + m!
}

function makeInput(overrides: Partial<SolverInput>): SolverInput {
  return {
    events: [],
    classes: [],
    coaches: [],
    placements: [],
    coachMode: 'class',
    adjacencyPenalties: [],
    seed: 1,
    ...overrides,
  }
}

const event = (id: number, name: string, capacity: number | null = 1, active = true) => ({
  id,
  name,
  capacity,
  active,
})

const cls = (
  id: number,
  name: string,
  requiredEvents: { eventId: number; duration: number }[],
  priority = 0,
  assignedCoaches: number[] = [],
) => ({ id, name, priority, requiredEvents, assignedCoaches })

/** A class in a column for a window; defaults to a 2-hour 16:00 window. */
const place = (
  id: number,
  classId: number,
  from = '16:00',
  to = '18:00',
  locked: SolverBlock[] = [],
): SolverPlacement => ({ id, classId, startMin: T(from), endMin: T(to), locked })

const block = (eventId: number, from: string, to: string, coachId: number | null = null) => ({
  eventId,
  coachId,
  startMin: T(from),
  endMin: T(to),
})

function expectOk(input: SolverInput) {
  const result = generateSchedule(input)
  expect(result.ok, `expected ok, got: ${!result.ok ? result.reasons.join(' | ') : ''}`).toBe(true)
  if (!result.ok) throw new Error('unreachable')
  expect(hardConstraintViolations(input, result.placements)).toEqual([])
  return result
}

function expectFail(input: SolverInput) {
  const result = generateSchedule(input)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.reasons.length).toBeGreaterThan(0)
  return result
}

/** Every block the solver returned, flattened. */
const allBlocks = (r: { placements: { blocks: SolverBlock[] }[] }) =>
  r.placements.flatMap((p) => p.blocks)

describe('trivial session', () => {
  it('schedules one class on one event inside its window', () => {
    const input = makeInput({
      events: [event(1, 'Vault')],
      classes: [cls(1, 'Level 3', [{ eventId: 1, duration: 30 }])],
      placements: [place(1, 1)],
    })
    const result = expectOk(input)
    expect(allBlocks(result)).toMatchObject([{ eventId: 1, startMin: T('16:00'), endMin: T('16:30') }])
  })

  it('leaves a class with no requirements alone — painting needs no setup', () => {
    const input = makeInput({
      events: [event(1, 'Vault')],
      classes: [cls(1, 'Level 3', [])],
      placements: [place(1, 1)],
    })
    const result = expectOk(input)
    expect(allBlocks(result)).toEqual([])
  })

  it('says so when nothing is placed yet', () => {
    const result = expectFail(makeInput({ events: [event(1, 'Vault')] }))
    expect(result.reasons[0]).toMatch(/add a class to a column/i)
  })
})

describe('class windows', () => {
  it('never places a block outside the class window', () => {
    // Silver only runs 16:00–17:00 even though the lane is longer.
    const input = makeInput({
      events: [event(1, 'Vault')],
      classes: [cls(1, 'Silver', [{ eventId: 1, duration: 30 }])],
      placements: [place(1, 1, '16:00', '17:00')],
    })
    const result = expectOk(input)
    for (const b of allBlocks(result)) {
      expect(b.startMin).toBeGreaterThanOrEqual(T('16:00'))
      expect(b.endMin).toBeLessThanOrEqual(T('17:00'))
    }
  })

  it('explains a class needing more than its own window, citing the window', () => {
    const result = expectFail(
      makeInput({
        events: [event(1, 'Vault')],
        classes: [cls(1, 'Silver', [{ eventId: 1, duration: 40 }])],
        placements: [place(1, 1, '16:00', '16:30')],
      }),
    )
    // The complaint is about Silver's window, not the session.
    expect(result.reasons.join(' ')).toContain('Silver')
    expect(result.reasons.join(' ')).toMatch(/40 min .* 30-min .*window/)
  })

  it('explains total required time exceeding the window', () => {
    const result = expectFail(
      makeInput({
        events: [event(1, 'Vault'), event(2, 'Beam')],
        classes: [
          cls(1, 'Silver', [
            { eventId: 1, duration: 30 },
            { eventId: 2, duration: 45 },
          ]),
        ],
        placements: [place(1, 1, '16:00', '17:00')],
      }),
    )
    expect(result.reasons.join(' ')).toMatch(/Silver has 75 min of required events .* 60-min/)
  })

  it('fits two classes with different windows on one capacity-1 event', () => {
    // They cannot collide: their windows barely touch.
    const input = makeInput({
      events: [event(1, 'Vault')],
      classes: [
        cls(1, 'LV 1', [{ eventId: 1, duration: 60 }]),
        cls(2, 'LV 2', [{ eventId: 1, duration: 60 }]),
      ],
      placements: [place(1, 1, '16:00', '17:00'), place(2, 2, '17:00', '18:00')],
    })
    const result = expectOk(input)
    expect(allBlocks(result)).toHaveLength(2)
  })

  it('reports overbooking when windows force a clash on one event', () => {
    const result = expectFail(
      makeInput({
        events: [event(1, 'Vault')],
        classes: [
          cls(1, 'A', [{ eventId: 1, duration: 60 }]),
          cls(2, 'B', [{ eventId: 1, duration: 60 }]),
        ],
        placements: [place(1, 1, '16:00', '17:00'), place(2, 2, '16:00', '17:00')],
      }),
    )
    expect(result.reasons.join(' ')).toContain('overbooked')
  })
})

describe('capacity', () => {
  it('lets an unlimited event hold every class at once', () => {
    const input = makeInput({
      events: [event(1, 'Open Gym', null)],
      classes: [1, 2, 3].map((i) => cls(i, `C${i}`, [{ eventId: 1, duration: 60 }])),
      placements: [place(1, 1, '16:00', '17:00'), place(2, 2, '16:00', '17:00'), place(3, 3, '16:00', '17:00')],
    })
    expect(allBlocks(expectOk(input))).toHaveLength(3)
  })

  it('respects a capacity above one', () => {
    const input = makeInput({
      events: [event(1, 'Floor', 2)],
      classes: [1, 2].map((i) => cls(i, `C${i}`, [{ eventId: 1, duration: 60 }])),
      placements: [place(1, 1, '16:00', '17:00'), place(2, 2, '16:00', '17:00')],
    })
    expect(allBlocks(expectOk(input))).toHaveLength(2)
  })
})

describe('requirements the solver cannot meet', () => {
  it('rejects an inactive required event', () => {
    const result = expectFail(
      makeInput({
        events: [event(1, 'Vault', 1, false)],
        classes: [cls(1, 'Boys Team', [{ eventId: 1, duration: 30 }])],
        placements: [place(1, 1)],
      }),
    )
    expect(result.reasons.join(' ')).toContain('inactive')
  })

  it('rejects a duration off the 5-minute axis', () => {
    const result = expectFail(
      makeInput({
        events: [event(1, 'Vault')],
        classes: [cls(1, 'Xcel', [{ eventId: 1, duration: 22 }])],
        placements: [place(1, 1)],
      }),
    )
    expect(result.reasons.join(' ')).toMatch(/multiple of 5/)
  })

  it('rejects a required event that no longer exists', () => {
    const result = expectFail(
      makeInput({
        events: [event(1, 'Vault')],
        classes: [cls(1, 'A', [{ eventId: 9, duration: 30 }])],
        placements: [place(1, 1)],
      }),
    )
    expect(result.reasons.join(' ')).toMatch(/no longer exists/)
  })

  it('reports every reason at once, not just the first', () => {
    const result = expectFail(
      makeInput({
        events: [event(1, 'Vault'), event(2, 'Beam', 1, false)],
        classes: [
          cls(1, 'A', [{ eventId: 1, duration: 300 }]),
          cls(2, 'B', [{ eventId: 2, duration: 30 }]),
        ],
        placements: [place(1, 1), place(2, 2)],
      }),
    )
    expect(result.reasons.length).toBeGreaterThan(1)
  })
})

describe('locked blocks', () => {
  it('keeps locked blocks exactly and plans around them', () => {
    const locked = block(1, '17:00', '17:30')
    const input = makeInput({
      events: [event(1, 'Vault'), event(2, 'Beam')],
      classes: [
        cls(1, 'Level 3', [
          { eventId: 1, duration: 30 },
          { eventId: 2, duration: 30 },
        ]),
      ],
      placements: [place(1, 1, '16:00', '18:00', [locked])],
    })
    const result = expectOk(input)
    const blocks = allBlocks(result)
    expect(blocks).toContainEqual(expect.objectContaining({ ...locked }))
    // The lock counts toward the Vault requirement rather than duplicating.
    expect(blocks.filter((b) => b.eventId === 1)).toHaveLength(1)
    expect(blocks.filter((b) => b.eventId === 2)).toHaveLength(1)
  })

  it('credits a partial lock and generates only the remainder', () => {
    const input = makeInput({
      events: [event(1, 'Vault')],
      classes: [cls(1, 'Level 3', [{ eventId: 1, duration: 60 }])],
      placements: [place(1, 1, '16:00', '18:00', [block(1, '16:00', '16:30')])],
    })
    const blocks = allBlocks(expectOk(input))
    const total = blocks
      .filter((b) => b.eventId === 1)
      .reduce((sum, b) => sum + (b.endMin - b.startMin), 0)
    expect(total).toBe(60)
  })

  it('rejects a locked block outside its class window', () => {
    const result = expectFail(
      makeInput({
        events: [event(1, 'Vault')],
        classes: [cls(1, 'Level 3', [])],
        placements: [place(1, 1, '16:00', '17:00', [block(1, '17:30', '18:00')])],
      }),
    )
    expect(result.reasons.join(' ')).toMatch(/outside its .* window/)
  })

  it('solves around locks belonging to other classes', () => {
    // Vault fits one class; A holds it 16:00–17:00, so B must take the rest.
    const input = makeInput({
      events: [event(1, 'Vault')],
      classes: [cls(1, 'A', []), cls(2, 'B', [{ eventId: 1, duration: 30 }])],
      placements: [place(1, 1, '16:00', '18:00', [block(1, '16:00', '17:00')]), place(2, 2)],
    })
    const result = expectOk(input)
    const b = result.placements.find((p) => p.placementId === 2)!.blocks[0]!
    expect(b.startMin).toBeGreaterThanOrEqual(T('17:00'))
  })
})

describe('soft constraints', () => {
  it('gives a higher-priority class the contested event', () => {
    const input = makeInput({
      events: [event(1, 'Vault')],
      classes: [
        cls(1, 'Rec', [{ eventId: 1, duration: 15 }], 0),
        cls(2, 'Optionals', [{ eventId: 1, duration: 15 }], 5),
      ],
      placements: [place(1, 1, '16:00', '16:30'), place(2, 2, '16:00', '16:30')],
    })
    const result = expectOk(input)
    const optionals = result.placements.find((p) => p.placementId === 2)!.blocks[0]!
    expect(optionals.startMin).toBe(T('16:00'))
  })

  it('keeps the assigned coach with the class in class mode', () => {
    const input = makeInput({
      events: [event(1, 'Vault')],
      classes: [cls(1, 'A', [{ eventId: 1, duration: 30 }], 0, [7])],
      coaches: [{ id: 7, name: 'Dana', specialties: [1] }],
      placements: [place(1, 1)],
    })
    expect(allBlocks(expectOk(input))[0]!.coachId).toBe(7)
  })

  it('never double-books one coach across two classes', () => {
    const input = makeInput({
      events: [event(1, 'Vault'), event(2, 'Beam')],
      classes: [
        cls(1, 'A', [{ eventId: 1, duration: 30 }], 0, [7]),
        cls(2, 'B', [{ eventId: 2, duration: 30 }], 0, [7]),
      ],
      coaches: [{ id: 7, name: 'Dana', specialties: [1, 2] }],
      placements: [place(1, 1, '16:00', '16:30'), place(2, 2, '16:00', '16:30')],
    })
    const result = expectOk(input)
    // Both need Dana at the same moment on different events — only one can
    // have her, and the other is left unstaffed rather than double-booked.
    const staffed = allBlocks(result).filter((b) => b.coachId === 7)
    expect(staffed).toHaveLength(1)
  })

  it('packs blocks toward the start of the window, minimizing idle time', () => {
    const input = makeInput({
      events: [event(1, 'Vault'), event(2, 'Beam')],
      classes: [
        cls(1, 'A', [
          { eventId: 1, duration: 30 },
          { eventId: 2, duration: 30 },
        ]),
      ],
      placements: [place(1, 1, '16:00', '18:00')],
    })
    const blocks = allBlocks(expectOk(input)).sort((a, b) => a.startMin - b.startMin)
    expect(blocks[0]!.startMin).toBe(T('16:00'))
    expect(blocks[1]!.startMin).toBe(blocks[0]!.endMin) // no gap
  })
})

describe('determinism', () => {
  it('same input and seed, same schedule', () => {
    const input = makeInput({
      events: [event(1, 'V'), event(2, 'B'), event(3, 'F')],
      classes: [1, 2, 3].map((i) =>
        cls(i, `C${i}`, [
          { eventId: 1, duration: 30 },
          { eventId: 2, duration: 30 },
          { eventId: 3, duration: 30 },
        ]),
      ),
      placements: [place(1, 1), place(2, 2), place(3, 3)],
      seed: 42,
    })
    expect(generateSchedule(input)).toEqual(generateSchedule(input))
  })

  it('a different seed is still valid', () => {
    const base = {
      events: [event(1, 'V'), event(2, 'B')],
      classes: [1, 2].map((i) =>
        cls(i, `C${i}`, [
          { eventId: 1, duration: 30 },
          { eventId: 2, duration: 30 },
        ]),
      ),
      placements: [place(1, 1), place(2, 2)],
    }
    expectOk(makeInput({ ...base, seed: 1 }))
    expectOk(makeInput({ ...base, seed: 999 }))
  })
})
