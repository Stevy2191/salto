import { describe, expect, it } from 'vitest'
import { overlaps } from '../../shared/slots.ts'
import { generatePlan } from './plan.ts'
import type { PlanEvent, PlanInput, PlanPlacement, PlanResult, PlanWeek } from './plan.ts'

// Fixtures build a whole-plan input: the same classes on the same clock, one
// placement per class per week. Blocks come out of generation, so placements
// start empty.

let nextPlacementId = 1

const placementsFor = (
  classIds: number[],
  window: [number, number],
  weeks = 4,
): PlanPlacement[] => {
  const placements: PlanPlacement[] = []
  for (let week = 1; week <= weeks; week++) {
    classIds.forEach((classId) => {
      placements.push({
        id: nextPlacementId++,
        classId,
        week,
        startMin: window[0],
        endMin: window[1],
        blocks: [],
      })
    })
  }
  return placements
}

const baseInput = (over: Partial<PlanInput> = {}): PlanInput => ({
  events: [],
  classes: [],
  coaches: [],
  placements: [],
  weekLocks: [false, false, false, false],
  coachMode: 'class',
  adjacencyPenalties: [],
  seed: 1,
  ...over,
})

const T = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h! * 60 + m!
}

/** Every hard-plan rule, checked independently of the generator. */
function violations(plan: PlanResult, input: PlanInput): string[] {
  if (!plan.ok) return [`plan failed: ${plan.reasons.join('; ')}`]
  const out: string[] = []
  const exclusive = new Set(input.events.filter((e) => !e.shared).map((e) => e.id))
  const windowOf = new Map(input.placements.map((p) => [p.id, [p.startMin, p.endMin] as const]))

  for (const week of plan.weeks) {
    // Blocks stay inside their window, snap to 5 min, don't overlap within a lane.
    for (const pr of week.placements) {
      const window = windowOf.get(pr.placementId)
      const ordered = [...pr.blocks].sort((a, b) => a.startMin - b.startMin)
      for (let i = 0; i < ordered.length; i++) {
        const b = ordered[i]!
        if (window && (b.startMin < window[0] || b.endMin > window[1])) {
          out.push(`week ${week.week}: block escapes window`)
        }
        if (b.startMin % 5 !== 0 || b.endMin % 5 !== 0) out.push(`week ${week.week}: off-axis block`)
        if (b.endMin <= b.startMin) out.push(`week ${week.week}: empty block`)
        if (i > 0 && ordered[i - 1]!.endMin > b.startMin) {
          out.push(`week ${week.week}: lane blocks overlap`)
        }
      }
    }

    // No two different classes on the same exclusive event at once.
    const spans: { placementId: number; eventId: number; s: number; e: number }[] = []
    for (const pr of week.placements) {
      for (const b of pr.blocks) {
        spans.push({ placementId: pr.placementId, eventId: b.eventId, s: b.startMin, e: b.endMin })
      }
    }
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
          out.push(`week ${week.week}: exclusive event ${a.eventId} double-booked`)
        }
      }
    }
  }
  return out
}

/** Every class visits every eligible event at least `floor` times. */
const coverageMet = (plan: PlanResult, floor = 2): boolean =>
  plan.ok && plan.coverage.every((c) => c.events.every((e) => e.visits >= floor))

const events = (specs: [number, string, boolean][]): PlanEvent[] =>
  specs.map(([id, name, shared]) => ({ id, name, shared, active: true }))

describe('generatePlan — comfortably solvable', () => {
  const evts = events([
    [1, 'Warm-up', true],
    [2, 'Stretch', true],
    [3, 'Vault', false],
    [4, 'Bars', false],
  ])
  const cls = (id: number, name: string, priority: number) => ({
    id,
    name,
    priority,
    eligibleEvents: [{ eventId: 3, minutes: 15 }, { eventId: 4, minutes: 15 }],
    periodMinutes: 60,
    warmupEventId: 1,
    warmupMinutes: 10,
    cooldownEventId: 2,
    cooldownMinutes: 10,
    assignedCoaches: [] as number[],
  })
  const input = baseInput({
    events: evts,
    classes: [cls(10, 'Alpha', 0), cls(11, 'Beta', 0)],
    placements: placementsFor([10, 11], [T('16:00'), T('17:30')]),
    seed: 7,
  })

  it('produces four weeks with no hard violations', () => {
    const plan = generatePlan(input)
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.weeks).toHaveLength(4)
    expect(violations(plan, input)).toEqual([])
  })

  it('meets the coverage floor for every class and event, with no warnings', () => {
    const plan = generatePlan(input)
    expect(coverageMet(plan)).toBe(true)
    if (plan.ok) expect(plan.warnings).toEqual([])
  })

  it('anchors the warm-up first and the cool-down last each week', () => {
    const plan = generatePlan(input)
    if (!plan.ok) throw new Error('expected a plan')
    for (const week of plan.weeks) {
      for (const pr of week.placements) {
        if (pr.blocks.length === 0) continue
        const ordered = [...pr.blocks].sort((a, b) => a.startMin - b.startMin)
        expect(ordered[0]!.eventId).toBe(1) // warm-up leads
        expect(ordered[ordered.length - 1]!.eventId).toBe(2) // cool-down closes
      }
    }
  })
})

describe('generatePlan — tightly contested (coverage impossible)', () => {
  // Three classes all want the one exclusive Trak, in a window that fits a
  // single visit per week. Four weeks / three classes can't give everyone two.
  const evts = events([[1, 'Tumble Trak', false]])
  const cls = (id: number, name: string) => ({
    id,
    name,
    priority: 0,
    eligibleEvents: [{ eventId: 1, minutes: 30 }],
    periodMinutes: 35,
    warmupEventId: null,
    warmupMinutes: 0,
    cooldownEventId: null,
    cooldownMinutes: 0,
    assignedCoaches: [] as number[],
  })
  const input = baseInput({
    events: evts,
    classes: [cls(1, 'X'), cls(2, 'Y'), cls(3, 'Z')],
    placements: placementsFor([1, 2, 3], [T('16:00'), T('16:35')]),
    seed: 3,
  })

  it('still returns a plan and never double-books the exclusive event', () => {
    const plan = generatePlan(input)
    expect(plan.ok).toBe(true)
    expect(violations(plan, input)).toEqual([])
  })

  it('flags the coverage gap in plain language instead of failing silently', () => {
    const plan = generatePlan(input)
    if (!plan.ok) throw new Error('expected a best-effort plan')
    expect(coverageMet(plan)).toBe(false)
    expect(plan.warnings.length).toBeGreaterThan(0)
    // A warning names the class and the event it comes up short on.
    expect(plan.warnings.some((w) => /Tumble Trak.*(X|Y|Z).*visits/.test(w))).toBe(true)
  })
})

describe('generatePlan — single class, trivial', () => {
  const input = baseInput({
    events: events([[1, 'Floor', false]]),
    classes: [
      {
        id: 1,
        name: 'Solo',
        priority: 0,
        eligibleEvents: [{ eventId: 1, minutes: 15 }],
        periodMinutes: 60,
        warmupEventId: null,
        warmupMinutes: 0,
        cooldownEventId: null,
        cooldownMinutes: 0,
        assignedCoaches: [],
      },
    ],
    placements: placementsFor([1], [T('16:00'), T('17:00')]),
    seed: 1,
  })

  it('covers its one event without contention or warnings', () => {
    const plan = generatePlan(input)
    expect(plan.ok).toBe(true)
    expect(violations(plan, input)).toEqual([])
    expect(coverageMet(plan)).toBe(true)
    if (plan.ok) expect(plan.warnings).toEqual([])
  })
})

describe('generatePlan — locks and determinism', () => {
  const evts = events([
    [1, 'Warm-up', true],
    [2, 'Vault', false],
    [3, 'Bars', false],
  ])
  // Built once so every variant shares the same placement ids — the plan is
  // only identifiable across runs if the lanes are the same objects.
  const placements = placementsFor([1], [T('16:00'), T('17:00')])
  const base = baseInput({
    events: evts,
    classes: [
      {
        id: 1,
        name: 'Alpha',
        priority: 0,
        eligibleEvents: [{ eventId: 2, minutes: 15 }, { eventId: 3, minutes: 15 }],
        periodMinutes: 45,
        warmupEventId: 1,
        warmupMinutes: 10,
        cooldownEventId: null,
        cooldownMinutes: 0,
        assignedCoaches: [],
      },
    ],
    placements,
    seed: 1,
  })

  it('is deterministic: same seed, identical plan', () => {
    const input = { ...base, seed: 42 }
    expect(generatePlan(input)).toEqual(generatePlan(input))
  })

  it('a different seed can produce a different arrangement', () => {
    // Not guaranteed for every pair, but across a handful of seeds the layout
    // should vary — otherwise the shuffle isn't doing anything.
    const layouts = new Set(
      [1, 2, 3, 4, 5].map((seed) => {
        const plan = generatePlan({ ...base, seed })
        return JSON.stringify(plan.ok ? plan.weeks : plan.reasons)
      }),
    )
    expect(layouts.size).toBeGreaterThan(1)
  })

  it('leaves a locked week exactly as it was', () => {
    // Generate once, freeze week 2's blocks into the input as a locked week,
    // regenerate with a different seed, and check week 2 is untouched.
    const first = generatePlan({ ...base, seed: 1 })
    if (!first.ok) throw new Error('expected a plan')
    const week2 = first.weeks.find((w) => w.week === 2)!

    const locked: PlanInput = {
      ...base,
      seed: 999,
      weekLocks: [false, true, false, false],
      // Paint week 2's generated blocks back into its placements as unlocked;
      // the week lock, not the block locks, is what must preserve them.
      placements: base.placements.map((p) => {
        if (p.week !== 2) return p
        const pr = week2.placements.find((r) => r.placementId === p.id)
        return pr ? { ...p, blocks: pr.blocks.map((b) => ({ ...b, locked: false })) } : p
      }),
    }

    const second = generatePlan(locked)
    if (!second.ok) throw new Error('expected a plan')
    expect(normalize(second.weeks.find((w) => w.week === 2)!)).toEqual(normalize(week2))
  })
})

/** Compare a week's blocks ignoring ordering noise. */
const normalize = (week: PlanWeek) =>
  week.placements
    .map((pr) => ({
      placementId: pr.placementId,
      blocks: [...pr.blocks].sort((a, b) => a.startMin - b.startMin || a.eventId - b.eventId),
    }))
    .sort((a, b) => a.placementId - b.placementId)
