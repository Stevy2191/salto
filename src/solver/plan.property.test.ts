import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { overlaps } from '../../shared/slots.ts'
import { generatePlan } from './plan.ts'
import type { PlanInput, PlanResult } from './plan.ts'

// Random-but-plausible four-week plans. All classes run the same clock (one
// session window), events carry a duration and a shared/exclusive flag, and
// classes draw from an eligible subset. Feasibility is NOT guaranteed — the
// property is that the plan is always internally valid and honestly flagged,
// never that every event reaches the coverage floor.
const DAY_START = 16 * 60

const arbInput: fc.Arbitrary<PlanInput> = fc
  .record({
    eventCount: fc.integer({ min: 1, max: 6 }),
    durations: fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 6, maxLength: 6 }),
    sharedMask: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
    inactiveMask: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
    classCount: fc.integer({ min: 1, max: 5 }),
    eligibleMasks: fc.array(
      fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
      { minLength: 5, maxLength: 5 },
    ),
    periods: fc.array(fc.integer({ min: 6, max: 18 }), { minLength: 5, maxLength: 5 }),
    warmups: fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }),
    cooldowns: fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }),
    priorities: fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 5, maxLength: 5 }),
    windowLen: fc.integer({ min: 6, max: 30 }),
    coachCount: fc.integer({ min: 0, max: 3 }),
    coachMode: fc.constantFrom('class' as const, 'event' as const),
    weekLocks: fc.array(fc.constant(false), { minLength: 4, maxLength: 4 }),
    seed: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
  })
  .map((raw) => {
    const events = Array.from({ length: raw.eventCount }, (_, i) => ({
      id: i + 1,
      name: `Event ${i + 1}`,
      duration: raw.durations[i]! * 5,
      shared: raw.sharedMask[i]!,
      active: i === 0 ? true : !raw.inactiveMask[i],
    }))
    const classes = Array.from({ length: raw.classCount }, (_, g) => {
      // Event 1 is the warm-up/cool-down anchor, so it is never also an
      // eligible rotation event — matching how gyms set up (shared warm-ups,
      // exclusive apparatus). This keeps coverage counting middle rotations.
      const eligible = events.filter((_, i) => i !== 0 && raw.eligibleMasks[g]![i]).map((e) => e.id)
      const warm = raw.warmups[g]!
      const cool = raw.cooldowns[g]!
      return {
        id: g + 1,
        name: `Class ${g + 1}`,
        priority: raw.priorities[g]!,
        eligibleEventIds: eligible,
        periodMinutes: raw.periods[g]! * 5,
        warmupEventId: warm ? 1 : null,
        warmupMinutes: warm ? 10 : 0,
        cooldownEventId: cool ? 1 : null,
        cooldownMinutes: cool ? 10 : 0,
        assignedCoaches: raw.coachCount > 0 ? [(g % raw.coachCount) + 1] : [],
      }
    })
    const coaches = Array.from({ length: raw.coachCount }, (_, c) => ({
      id: c + 1,
      name: `Coach ${c + 1}`,
      specialties: events.filter((e) => e.id % raw.coachCount === c % raw.coachCount).map((e) => e.id),
    }))
    // Every class on the same clock, one placement per week.
    const window: [number, number] = [DAY_START, DAY_START + raw.windowLen * 5]
    let pid = 1
    const placements = []
    for (let week = 1; week <= 4; week++) {
      for (const c of classes) {
        placements.push({
          id: pid++,
          classId: c.id,
          week,
          startMin: window[0],
          endMin: window[1],
          blocks: [],
        })
      }
    }
    return {
      events,
      classes,
      coaches,
      placements,
      weekLocks: raw.weekLocks,
      coachMode: raw.coachMode,
      adjacencyPenalties: [],
      seed: raw.seed,
    }
  })

/** Hard-plan violations, checked independently of the generator. */
function violations(plan: PlanResult, input: PlanInput): string[] {
  if (!plan.ok) return []
  const out: string[] = []
  const exclusive = new Set(input.events.filter((e) => !e.shared).map((e) => e.id))
  const windowOf = new Map(input.placements.map((p) => [p.id, [p.startMin, p.endMin] as const]))

  for (const week of plan.weeks) {
    for (const pr of week.placements) {
      const window = windowOf.get(pr.placementId)
      const ordered = [...pr.blocks].sort((a, b) => a.startMin - b.startMin)
      for (let i = 0; i < ordered.length; i++) {
        const b = ordered[i]!
        if (window && (b.startMin < window[0] || b.endMin > window[1])) out.push('escapes window')
        if (b.startMin % 5 !== 0 || b.endMin % 5 !== 0) out.push('off axis')
        if (b.endMin <= b.startMin) out.push('empty block')
        if (i > 0 && ordered[i - 1]!.endMin > b.startMin) out.push('lane overlap')
      }
    }
    // Exclusive events never held by two classes at once.
    const spans = week.placements.flatMap((pr) =>
      pr.blocks.map((b) => ({ placementId: pr.placementId, eventId: b.eventId, s: b.startMin, e: b.endMin })),
    )
    for (let i = 0; i < spans.length; i++) {
      for (let j = i + 1; j < spans.length; j++) {
        const a = spans[i]!
        const b = spans[j]!
        if (
          a.eventId === b.eventId &&
          exclusive.has(a.eventId) &&
          a.placementId !== b.placementId &&
          overlaps(a.s, a.e, b.s, b.e)
        ) {
          out.push('exclusive double-booked')
        }
      }
    }
  }
  return out
}

describe('plan properties', () => {
  it('a plan is always internally valid: no exclusive collisions, blocks in window', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        expect(violations(generatePlan(input), input)).toEqual([])
      }),
      { numRuns: 300 },
    )
  })

  it('is best-effort: non-empty placements always yield a plan with four weeks', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const plan = generatePlan(input)
        expect(plan.ok).toBe(true)
        if (plan.ok) expect(plan.weeks.map((w) => w.week).sort()).toEqual([1, 2, 3, 4])
      }),
      { numRuns: 150 },
    )
  })

  it('coverage is sane: one entry per eligible event, visits within [0, 3]', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const plan = generatePlan(input)
        if (!plan.ok) return
        const eligibleOf = new Map(input.classes.map((c) => [c.id, c.eligibleEventIds]))
        for (const cls of plan.coverage) {
          expect(cls.events.map((e) => e.eventId).sort()).toEqual(
            [...(eligibleOf.get(cls.classId) ?? [])].sort(),
          )
          for (const e of cls.events) {
            expect(e.visits).toBeGreaterThanOrEqual(0)
            expect(e.visits).toBeLessThanOrEqual(3)
            expect(e.short).toBe(e.visits < 2)
          }
        }
      }),
      { numRuns: 150 },
    )
  })

  it('every warning is a non-empty human-readable string', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const plan = generatePlan(input)
        if (!plan.ok) return
        expect(plan.warnings.every((w) => typeof w === 'string' && w.length > 10)).toBe(true)
      }),
      { numRuns: 150 },
    )
  })

  it('is deterministic: same input and seed, same plan', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        expect(generatePlan(input)).toEqual(generatePlan(input))
      }),
      { numRuns: 100 },
    )
  })

  it('a locked week is never altered by regeneration', () => {
    fc.assert(
      fc.property(arbInput, fc.integer({ min: 1, max: 4 }), fc.integer({ min: 0, max: 2 ** 31 - 1 }), (input, lockWeek, seed2) => {
        // Generate once, freeze the chosen week's blocks in as a locked week,
        // regenerate with a fresh seed, and require that week untouched.
        const first = generatePlan(input)
        if (!first.ok) return
        const frozen = first.weeks.find((w) => w.week === lockWeek)!
        const weekLocks = [false, false, false, false]
        weekLocks[lockWeek - 1] = true
        const locked: PlanInput = {
          ...input,
          seed: seed2,
          weekLocks,
          placements: input.placements.map((p) => {
            if (p.week !== lockWeek) return p
            const pr = frozen.placements.find((r) => r.placementId === p.id)
            return pr ? { ...p, blocks: pr.blocks.map((b) => ({ ...b, locked: false })) } : p
          }),
        }
        const second = generatePlan(locked)
        if (!second.ok) return
        const norm = (week: (typeof first.weeks)[number]) =>
          week.placements
            .map((pr) => ({
              placementId: pr.placementId,
              blocks: [...pr.blocks].sort((a, b) => a.startMin - b.startMin || a.eventId - b.eventId),
            }))
            .sort((a, b) => a.placementId - b.placementId)
        expect(norm(second.weeks.find((w) => w.week === lockWeek)!)).toEqual(norm(frozen))
      }),
      { numRuns: 120 },
    )
  })
})
