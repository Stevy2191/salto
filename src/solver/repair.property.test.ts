import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { generateSchedule } from './solver.ts'
import { repairSchedule } from './repair.ts'
import type { RepairInput } from './repair.ts'
import { hardConstraintViolations } from './validate.ts'
import type { SolverInput } from './types.ts'

const DAY_START = 16 * 60

/** A random gym on the lane model, plus an outage to repair around. */
const arbScenario = fc
  .record({
    eventCount: fc.integer({ min: 1, max: 5 }),
    capacities: fc.array(fc.constantFrom<number | null>(1, 2, null), { minLength: 5, maxLength: 5 }),
    classCount: fc.integer({ min: 1, max: 5 }),
    requirements: fc.array(
      fc.array(
        fc.record({
          eventIndex: fc.nat({ max: 4 }),
          durationSlots: fc.integer({ min: 1, max: 3 }),
          position: fc.constantFrom('FIRST' as const, 'ANY' as const, 'LAST' as const),
        }),
        { maxLength: 3 },
      ),
      { minLength: 5, maxLength: 5 },
    ),
    windows: fc.array(
      fc.record({
        startSlot: fc.integer({ min: 0, max: 12 }),
        lengthSlots: fc.integer({ min: 1, max: 24 }),
      }),
      { minLength: 5, maxLength: 5 },
    ),
    coachCount: fc.integer({ min: 1, max: 3 }),
    coachMode: fc.constantFrom('class' as const, 'event' as const),
    seed: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
    repairSeed: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
    outEventMask: fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }),
    absentCoachMask: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
  })
  .map((raw) => {
    const events = Array.from({ length: raw.eventCount }, (_, i) => ({
      id: i + 1,
      name: `Event ${i + 1}`,
      capacity: raw.capacities[i]!,
      active: true,
    }))
    const classes = Array.from({ length: raw.classCount }, (_, g) => {
      const seen = new Set<number>()
      const requiredEvents = raw.requirements[g]!
        .map((r) => ({
          eventId: (r.eventIndex % raw.eventCount) + 1,
          duration: r.durationSlots * 5,
          position: r.position,
        }))
        .filter((r) => (seen.has(r.eventId) ? false : (seen.add(r.eventId), true)))
      return {
        id: g + 1,
        name: `Class ${g + 1}`,
        priority: g % 3,
        requiredEvents,
        assignedCoaches: [(g % raw.coachCount) + 1],
      }
    })
    const coaches = Array.from({ length: raw.coachCount }, (_, c) => ({
      id: c + 1,
      name: `Coach ${c + 1}`,
      specialties: events.map((e) => e.id),
    }))
    const placements = classes.map((c, i) => {
      const w = raw.windows[i]!
      const startMin = DAY_START + w.startSlot * 5
      return { id: i + 1, classId: c.id, startMin, endMin: startMin + w.lengthSlots * 5, locked: [] }
    })
    const base: SolverInput = {
      events,
      classes,
      coaches,
      placements,
      coachMode: raw.coachMode,
      adjacencyPenalties: [],
      seed: raw.seed,
    }
    return {
      base,
      repairSeed: raw.repairSeed,
      unavailableEventIds: events.filter((_, i) => raw.outEventMask[i]).map((e) => e.id),
      absentCoachIds: coaches.filter((_, i) => raw.absentCoachMask[i]).map((c) => c.id),
    }
  })

/** Feed a solved grid back in as the painted state to repair. */
function toRepairInput(
  base: SolverInput,
  solved: { placementId: number; blocks: { eventId: number; coachId: number | null; startMin: number; endMin: number }[] }[],
  absentCoachIds: number[],
  unavailableEventIds: number[],
  seed: number,
): RepairInput {
  return {
    ...base,
    seed,
    absentCoachIds,
    unavailableEventIds,
    placements: base.placements.map((p) => ({
      id: p.id,
      classId: p.classId,
      startMin: p.startMin,
      endMin: p.endMin,
      blocks: (solved.find((r) => r.placementId === p.id)?.blocks ?? []).map((b) => ({
        ...b,
        locked: false,
      })),
    })),
  }
}

const allBlocks = (r: { placements: { blocks: { eventId: number; coachId: number | null }[] }[] }) =>
  r.placements.flatMap((p) => p.blocks)

describe('repair properties', () => {
  it('never violates hard constraints in the post-outage world', () => {
    fc.assert(
      fc.property(arbScenario, ({ base, unavailableEventIds, absentCoachIds, repairSeed }) => {
        const generated = generateSchedule(base)
        if (!generated.ok) return
        const repaired = repairSchedule(
          toRepairInput(base, generated.placements, absentCoachIds, unavailableEventIds, repairSeed),
        )
        if (!repaired.ok) {
          expect(repaired.reasons.length).toBeGreaterThan(0)
          return
        }
        const down = new Set(unavailableEventIds)
        const absent = new Set(absentCoachIds)
        // Validate against the effective world of the outage.
        const effective: SolverInput = {
          ...base,
          events: base.events.map((e) => (down.has(e.id) ? { ...e, active: false } : e)),
          coaches: base.coaches.filter((c) => !absent.has(c.id)),
          classes: base.classes.map((c) => ({
            ...c,
            requiredEvents: c.requiredEvents.filter((r) => !down.has(r.eventId)),
          })),
        }
        expect(hardConstraintViolations(effective, repaired.placements)).toEqual([])
        // The outage is really gone from the grid.
        expect(allBlocks(repaired).every((b) => !down.has(b.eventId))).toBe(true)
        expect(
          allBlocks(repaired).every((b) => b.coachId === null || !absent.has(b.coachId)),
        ).toBe(true)
      }),
      { numRuns: 150 },
    )
  })

  it('never modifies blocks untouched by the outage', () => {
    fc.assert(
      fc.property(arbScenario, ({ base, unavailableEventIds, absentCoachIds, repairSeed }) => {
        const generated = generateSchedule(base)
        if (!generated.ok) return
        const repaired = repairSchedule(
          toRepairInput(base, generated.placements, absentCoachIds, unavailableEventIds, repairSeed),
        )
        if (!repaired.ok) return
        const down = new Set(unavailableEventIds)
        const absent = new Set(absentCoachIds)
        for (const before of generated.placements) {
          const after = repaired.placements.find((r) => r.placementId === before.placementId)!
          for (const b of before.blocks) {
            const touched = down.has(b.eventId) || (b.coachId !== null && absent.has(b.coachId))
            if (touched) continue
            // Untouched → present, identical, coach included.
            expect(after.blocks).toContainEqual(b)
          }
        }
      }),
      { numRuns: 150 },
    )
  })

  it('is deterministic', () => {
    fc.assert(
      fc.property(arbScenario, ({ base, unavailableEventIds, absentCoachIds, repairSeed }) => {
        const generated = generateSchedule(base)
        if (!generated.ok) return
        const input = toRepairInput(
          base,
          generated.placements,
          absentCoachIds,
          unavailableEventIds,
          repairSeed,
        )
        expect(repairSchedule(input)).toEqual(repairSchedule(input))
      }),
      { numRuns: 75 },
    )
  })
})
