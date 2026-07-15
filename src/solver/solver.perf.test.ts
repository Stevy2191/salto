import { describe, expect, it } from 'vitest'
import { generateSchedule } from './solver.ts'
import { hardConstraintViolations } from './validate.ts'
import type { SolverInput } from './types.ts'

// Spec: generation should feel instant (<2s) at realistic size — ~16 classes,
// ~8 events, a 4-hour window at 5-minute rows. That is 48 rows x 16 lanes,
// which is what a real gym's Monday actually looks like.
const START = 16 * 60 // 16:00

function realisticGym(): SolverInput {
  // A big gym's Monday: a handful of team squads rotating the competitive
  // apparatus (one class at a time each), plus a crowd of rec classes
  // sharing the high-capacity floor space. Real evenings look like this —
  // they are busy, but they are not 100% saturated on every apparatus, and
  // a fixture that is exactly tight tests backtracking luck, not speed.
  const events = [
    { id: 1, name: 'Vault', capacity: 1, active: true },
    { id: 2, name: 'Uneven Bars', capacity: 1, active: true },
    { id: 3, name: 'Balance Beam', capacity: 1, active: true },
    { id: 4, name: 'Floor', capacity: 3, active: true },
    { id: 5, name: 'Tumble Track', capacity: 2, active: true },
    { id: 6, name: 'Pit', capacity: 1, active: true },
    { id: 7, name: 'Conditioning', capacity: null, active: true },
    { id: 8, name: 'Trampoline', capacity: 2, active: true },
  ]
  const coaches = Array.from({ length: 6 }, (_, c) => ({
    id: c + 1,
    name: `Coach ${c + 1}`,
    specialties: events.filter((e) => e.id % 6 === c).map((e) => e.id),
  }))

  const TEAM = 6
  const REC = 10
  const classes = [
    // Team squads: the four competitive apparatus, 30 min each, all evening.
    ...Array.from({ length: TEAM }, (_, i) => ({
      id: i + 1,
      name: `Team ${i + 1}`,
      priority: 2,
      requiredEvents: [1, 2, 3, 6].map((eventId) => ({ eventId, duration: 30 })),
      assignedCoaches: [(i % 6) + 1],
    })),
    // Rec classes: floor, tramp, tumble, conditioning — shared apparatus.
    ...Array.from({ length: REC }, (_, i) => ({
      id: TEAM + i + 1,
      name: `Rec ${i + 1}`,
      priority: i % 2,
      requiredEvents: [4, 8, 5, 7].map((eventId) => ({ eventId, duration: 20 })),
      assignedCoaches: [(i % 6) + 1],
    })),
  ]

  // Staggered windows: teams run the full four hours, rec classes take a
  // three-hour slice starting an hour in.
  const placements = classes.map((c, i) => ({
    id: i + 1,
    classId: c.id,
    startMin: i < TEAM ? START : START + 60,
    endMin: START + 240,
    locked: [],
  }))

  return {
    events,
    classes,
    coaches,
    placements,
    coachMode: 'class',
    adjacencyPenalties: [{ beforeEventId: 7, afterEventId: 3 }],
    seed: 7,
  }
}

describe('solver performance at real gym size', () => {
  it('solves 16 classes across a 4-hour window at 5-minute rows in under 2s', () => {
    const input = realisticGym()
    const started = performance.now()
    const result = generateSchedule(input)
    const elapsed = performance.now() - started

    expect(result.ok, !result.ok ? result.reasons.join(' | ') : '').toBe(true)
    if (result.ok) {
      expect(hardConstraintViolations(input, result.placements)).toEqual([])
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

  it('stays fast when the grid is already painted solid — the day-of shape', () => {
    const input = realisticGym()
    const solved = generateSchedule(input)
    if (!solved.ok) throw new Error('setup failed')
    // Feed the whole solved grid back as locks: nothing left to place, but
    // every slot is occupied. Regenerating must not crawl.
    const relocked: SolverInput = {
      ...input,
      placements: input.placements.map((p) => ({
        ...p,
        locked: solved.placements.find((r) => r.placementId === p.id)!.blocks,
      })),
    }
    const started = performance.now()
    const result = generateSchedule(relocked)
    expect(performance.now() - started).toBeLessThan(2000)
    expect(result.ok).toBe(true)
  })
})
