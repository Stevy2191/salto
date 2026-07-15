import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { generateSchedule } from './solver.ts'
import { hardConstraintViolations } from './validate.ts'
import type { SolverInput } from './types.ts'

// Random-but-plausible gym setups. Durations are always multiples of the
// rotation length; feasibility is NOT guaranteed — the property is that the
// solver either returns a valid schedule or explains why not.
const arbInput: fc.Arbitrary<SolverInput> = fc
  .record({
    eventCount: fc.integer({ min: 1, max: 6 }),
    capacities: fc.array(fc.integer({ min: 1, max: 2 }), { minLength: 6, maxLength: 6 }),
    inactiveMask: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
    classCount: fc.integer({ min: 1, max: 8 }),
    requirements: fc.array(
      fc.array(
        fc.record({
          eventIndex: fc.nat({ max: 5 }),
          durationSlots: fc.integer({ min: 1, max: 4 }),
        }),
        { maxLength: 4 },
      ),
      { minLength: 8, maxLength: 8 },
    ),
    priorities: fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 8, maxLength: 8 }),
    coachCount: fc.integer({ min: 0, max: 4 }),
    slotCount: fc.integer({ min: 3, max: 14 }),
    rotationLength: fc.constantFrom(5, 10, 15, 30),
    coachMode: fc.constantFrom('class' as const, 'event' as const),
    seed: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
  })
  .map((raw) => {
    const events = Array.from({ length: raw.eventCount }, (_, i) => ({
      id: i + 1,
      name: `Event ${i + 1}`,
      capacity: raw.capacities[i]!,
      // Keep at least one active event so setups aren't degenerate.
      active: i === 0 ? true : !raw.inactiveMask[i],
    }))
    const classes = Array.from({ length: raw.classCount }, (_, g) => {
      const seen = new Set<number>()
      const requiredEvents = raw.requirements[g]!
        .map((r) => ({
          eventId: (r.eventIndex % raw.eventCount) + 1,
          duration: r.durationSlots * raw.rotationLength,
        }))
        .filter((r) => (seen.has(r.eventId) ? false : (seen.add(r.eventId), true)))
      return {
        id: g + 1,
        name: `Class ${g + 1}`,
        priority: raw.priorities[g]!,
        requiredEvents,
        assignedCoaches: raw.coachCount > 0 ? [(g % raw.coachCount) + 1] : [],
      }
    })
    const coaches = Array.from({ length: raw.coachCount }, (_, c) => ({
      id: c + 1,
      name: `Coach ${c + 1}`,
      specialties: events.filter((e) => e.id % raw.coachCount === c % raw.coachCount).map((e) => e.id),
    }))
    return {
      events,
      classes,
      coaches,
      slotCount: raw.slotCount,
      rotationLength: raw.rotationLength,
      coachMode: raw.coachMode,
      adjacencyPenalties: [],
      locked: [],
      seed: raw.seed,
    }
  })

describe('solver properties', () => {
  it('an ok result never violates a hard constraint', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const result = generateSchedule(input)
        if (result.ok) {
          expect(hardConstraintViolations(input, result.assignments)).toEqual([])
        }
      }),
      { numRuns: 300 },
    )
  })

  it('a failure always carries at least one human-readable reason', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const result = generateSchedule(input)
        if (!result.ok) {
          expect(result.reasons.length).toBeGreaterThan(0)
          expect(result.reasons.every((r) => typeof r === 'string' && r.length > 10)).toBe(true)
        }
      }),
      { numRuns: 150 },
    )
  })

  it('is deterministic: same input and seed, same result', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        expect(generateSchedule(input)).toEqual(generateSchedule(input))
      }),
      { numRuns: 100 },
    )
  })
})
