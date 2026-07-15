import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { generateSchedule } from './solver.ts'
import { repairSchedule } from './repair.ts'
import type { RepairInput } from './repair.ts'
import { hardConstraintViolations } from './validate.ts'
import type { SolverInput } from './types.ts'

// Compact random gyms (kept small so most are solvable), plus outage picks.
const arbScenario = fc
  .record({
    eventCount: fc.integer({ min: 2, max: 5 }),
    capacities: fc.array(fc.integer({ min: 1, max: 2 }), { minLength: 5, maxLength: 5 }),
    classCount: fc.integer({ min: 1, max: 5 }),
    requirements: fc.array(
      fc.array(
        fc.record({
          eventIndex: fc.nat({ max: 4 }),
          durationSlots: fc.integer({ min: 1, max: 3 }),
        }),
        { maxLength: 3 },
      ),
      { minLength: 5, maxLength: 5 },
    ),
    coachCount: fc.integer({ min: 1, max: 3 }),
    slotCount: fc.integer({ min: 4, max: 12 }),
    coachMode: fc.constantFrom('class' as const, 'event' as const),
    seed: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
    repairSeed: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
    downEventIndex: fc.nat({ max: 4 }),
    absentCoachIndex: fc.nat({ max: 2 }),
    outageKind: fc.constantFrom('event', 'coach', 'both'),
  })
  .map((raw) => {
    const events = Array.from({ length: raw.eventCount }, (_, i) => ({
      id: i + 1,
      name: `Event ${i + 1}`,
      capacity: raw.capacities[i]!,
      active: true,
    }))
    const coaches = Array.from({ length: raw.coachCount }, (_, c) => ({
      id: c + 1,
      name: `Coach ${c + 1}`,
      specialties: events.map((e) => e.id),
    }))
    const classes = Array.from({ length: raw.classCount }, (_, g) => {
      const seen = new Set<number>()
      return {
        id: g + 1,
        name: `Class ${g + 1}`,
        priority: g,
        requiredEvents: raw.requirements[g]!
          .map((r) => ({
            eventId: (r.eventIndex % raw.eventCount) + 1,
            duration: r.durationSlots * 15,
          }))
          .filter((r) => (seen.has(r.eventId) ? false : (seen.add(r.eventId), true))),
        assignedCoaches: [(g % raw.coachCount) + 1],
      }
    })
    const base: SolverInput = {
      events,
      classes,
      coaches,
      slotCount: raw.slotCount,
      rotationLength: 15,
      coachMode: raw.coachMode,
      adjacencyPenalties: [],
      locked: [],
      seed: raw.seed,
    }
    const unavailableEventIds =
      raw.outageKind !== 'coach' ? [(raw.downEventIndex % raw.eventCount) + 1] : []
    const absentCoachIds =
      raw.outageKind !== 'event' ? [(raw.absentCoachIndex % raw.coachCount) + 1] : []
    return { base, unavailableEventIds, absentCoachIds, repairSeed: raw.repairSeed }
  })

function toRepairInput(
  base: SolverInput,
  original: RepairInput['original'],
  absentCoachIds: number[],
  unavailableEventIds: number[],
  seed: number,
): RepairInput {
  const { locked: _locked, ...rest } = base
  return { ...rest, seed, original, absentCoachIds, unavailableEventIds }
}

describe('repair properties', () => {
  it('never violates hard constraints in the post-outage world', () => {
    fc.assert(
      fc.property(arbScenario, ({ base, unavailableEventIds, absentCoachIds, repairSeed }) => {
        const generatedResult = generateSchedule(base)
        if (!generatedResult.ok) return
        const repaired = repairSchedule(
          toRepairInput(base, generatedResult.assignments, absentCoachIds, unavailableEventIds, repairSeed),
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
          classes: base.classes.map((g) => ({
            ...g,
            requiredEvents: g.requiredEvents.filter((r) => !down.has(r.eventId)),
          })),
        }
        expect(hardConstraintViolations(effective, repaired.assignments)).toEqual([])
        // The outage is really gone from the schedule.
        expect(repaired.assignments.every((a) => !down.has(a.eventId))).toBe(true)
        expect(
          repaired.assignments.every((a) => a.coachId === null || !absent.has(a.coachId)),
        ).toBe(true)
      }),
      { numRuns: 150 },
    )
  })

  it('never modifies assignments untouched by the outage', () => {
    fc.assert(
      fc.property(arbScenario, ({ base, unavailableEventIds, absentCoachIds, repairSeed }) => {
        const generatedResult = generateSchedule(base)
        if (!generatedResult.ok) return
        const original = generatedResult.assignments
        const repaired = repairSchedule(
          toRepairInput(base, original, absentCoachIds, unavailableEventIds, repairSeed),
        )
        if (!repaired.ok) return
        const down = new Set(unavailableEventIds)
        const absent = new Set(absentCoachIds)
        for (const a of original) {
          const touched =
            down.has(a.eventId) || (a.coachId !== null && absent.has(a.coachId))
          if (touched) continue
          // Untouched → present, identical, coach included.
          expect(repaired.assignments).toContainEqual(a)
        }
      }),
      { numRuns: 150 },
    )
  })

  it('is deterministic', () => {
    fc.assert(
      fc.property(arbScenario, ({ base, unavailableEventIds, absentCoachIds, repairSeed }) => {
        const generatedResult = generateSchedule(base)
        if (!generatedResult.ok) return
        const input = toRepairInput(
          base,
          generatedResult.assignments,
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
