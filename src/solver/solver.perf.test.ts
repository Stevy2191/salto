import { describe, expect, it } from 'vitest'
import { generateSchedule } from './solver.ts'
import { hardConstraintViolations } from './validate.ts'
import type { SolverInput } from './types.ts'

// Spec: generation should feel instant (<2s) for realistic sizes —
// ~10 classes, ~8 events, 12+ slots.
function realisticGym(): SolverInput {
  const events = [
    { id: 1, name: 'Vault', capacity: 1, active: true },
    { id: 2, name: 'Uneven Bars', capacity: 1, active: true },
    { id: 3, name: 'Balance Beam', capacity: 1, active: true },
    { id: 4, name: 'Floor', capacity: 2, active: true },
    { id: 5, name: 'Tumble Track', capacity: 1, active: true },
    { id: 6, name: 'Pit', capacity: 1, active: true },
    { id: 7, name: 'Conditioning', capacity: 2, active: true },
    { id: 8, name: 'Trampoline', capacity: 1, active: true },
  ]
  const coaches = Array.from({ length: 6 }, (_, c) => ({
    id: c + 1,
    name: `Coach ${c + 1}`,
    specialties: events.filter((e) => e.id % 6 === c).map((e) => e.id),
  }))
  // Each class rotates through 4 events (staggered so demand spreads),
  // 2 slots on two of them and 1 slot on the others → 6 slots of 12 used.
  const classes = Array.from({ length: 10 }, (_, g) => ({
    id: g + 1,
    name: `Class ${g + 1}`,
    priority: g % 3,
    requiredEvents: [0, 2, 4, 6].map((offset, i) => ({
      eventId: ((g + offset) % 8) + 1,
      duration: (i < 2 ? 2 : 1) * 15,
    })),
    assignedCoaches: [(g % 6) + 1],
  }))
  return {
    events,
    classes,
    coaches,
    slotCount: 12,
    rotationLength: 15,
    coachMode: 'class',
    adjacencyPenalties: [{ beforeEventId: 7, afterEventId: 3 }],
    locked: [],
    seed: 7,
  }
}

describe('solver performance', () => {
  it('solves a realistic gym (10 classes, 8 events, 12 slots) in under 2s', () => {
    const input = realisticGym()
    const started = performance.now()
    const result = generateSchedule(input)
    const elapsed = performance.now() - started

    expect(result.ok, !result.ok ? result.reasons.join(' | ') : '').toBe(true)
    if (result.ok) {
      expect(hardConstraintViolations(input, result.assignments)).toEqual([])
    }
    expect(elapsed).toBeLessThan(2000)
  })

  it('stays under 2s across many seeds', () => {
    const input = realisticGym()
    const started = performance.now()
    for (let seed = 1; seed <= 10; seed++) {
      const result = generateSchedule({ ...input, seed })
      expect(result.ok).toBe(true)
    }
    expect((performance.now() - started) / 10).toBeLessThan(2000)
  })
})
