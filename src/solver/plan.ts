// Four-week rotation plan generator. Pure: plain data in, a plan or a failure
// out. No UI, DOM, or database imports.
//
// A plan is PLAN_WEEKS weeks on the same clock. Each week each class does its
// warm-up, a subset of its eligible events that fits its period, and its
// cool-down. Across the whole plan every eligible event should be attended at
// least `coverageFloor` times (default 2), spread evenly, with under-used
// events preferred in later weeks. Within a week the single-week solver
// resolves contention: exclusive events are never double-booked, shared ones
// may overlap. Locked weeks are left exactly as they are; unlocked weeks
// reflow. Deterministic for a given seed.
//
// The heavy lifting — placing a week's events in time without colliding on an
// exclusive apparatus, honouring warm-up/cool-down anchors and locked blocks,
// and staffing coaches — is delegated to `generateSchedule`, one call per
// unlocked week. This module owns only what is new: which events each class
// does each week (for coverage), and the plan-wide flags.
import { PLAN_WEEKS } from '../../shared/types.ts'
import type { ClassCoverage, CoachMode, EventCoverage } from '../../shared/types.ts'
import { mulberry32, shuffled } from './rng.ts'
import { generateSchedule } from './solver.ts'
import type { AdjacencyPenalty, SolverBlock, SolverCoach, SolverPlacementResult } from './types.ts'

/** An event in the facility catalog, as the plan sees it. */
export interface PlanEvent {
  id: number
  name: string
  /** Minutes a class spends here per visit. */
  duration: number
  /** Shared events hold any number of classes at once; exclusive ones, one. */
  shared: boolean
  active: boolean
}

export interface PlanClass {
  id: number
  name: string
  priority: number
  /** Events this class may rotate through; a subset is drawn each week. */
  eligibleEventIds: number[]
  periodMinutes: number
  warmupEventId: number | null
  warmupMinutes: number
  cooldownEventId: number | null
  cooldownMinutes: number
  assignedCoaches: number[]
}

/** A block already on the grid, with whether it is locked against reflow. */
export interface PlanBlock extends SolverBlock {
  locked: boolean
}

/** One class's lane for one week. */
export interface PlanPlacement {
  id: number
  classId: number
  /** 1..PLAN_WEEKS. */
  week: number
  startMin: number
  endMin: number
  /** Everything currently painted here, locked or not. */
  blocks: PlanBlock[]
}

export interface PlanInput {
  events: PlanEvent[]
  classes: PlanClass[]
  coaches: SolverCoach[]
  /** Every class's placement in every week. */
  placements: PlanPlacement[]
  /** Which weeks are locked (index 0 = week 1); length PLAN_WEEKS. */
  weekLocks: boolean[]
  coachMode: CoachMode
  adjacencyPenalties: AdjacencyPenalty[]
  seed: number
  /** Minimum visits per eligible event across the plan. Default 2. */
  coverageFloor?: number
}

export interface PlanWeek {
  week: number
  placements: SolverPlacementResult[]
}

export interface PlanSuccess {
  ok: true
  seed: number
  weeks: PlanWeek[]
  /** Per class, how many times each eligible event is actually attended. */
  coverage: ClassCoverage[]
  /** Plain-language gaps: coverage shortfalls and weeks that couldn't fill. */
  warnings: string[]
}

export interface PlanFailure {
  ok: false
  reasons: string[]
}

export type PlanResult = PlanSuccess | PlanFailure

const COVERAGE_TARGET_CAP = 3

/**
 * Generate a full rotation plan. Best-effort: it returns a plan with warnings
 * rather than failing, unless the input is structurally empty.
 */
export function generatePlan(input: PlanInput): PlanResult {
  const weeks = input.weekLocks.length || PLAN_WEEKS
  const floor = input.coverageFloor ?? 2
  if (input.placements.length === 0) {
    return { ok: false, reasons: ['No classes are placed yet — add a class to a session first.'] }
  }

  const rand = mulberry32(input.seed)
  const eventById = new Map(input.events.map((e) => [e.id, e]))
  const classById = new Map(input.classes.map((c) => [c.id, c]))
  const solverEvents = input.events.map((e) => ({
    id: e.id,
    name: e.name,
    // Shared events have no simultaneous-class limit; exclusive ones allow one.
    capacity: e.shared ? null : 1,
    active: e.active,
  }))

  // --- Which eligible events each class does each week (coverage-driven). ---
  // Independent per class; the week solver later resolves contention between
  // classes. Iterated in a fixed order so the plan is deterministic.
  const classesById = [...classById.keys()].sort((a, b) => a - b)
  // subsets[classId][weekIndex] = ordered middle event ids.
  const subsets = new Map<number, number[][]>()
  for (const classId of classesById) {
    subsets.set(classId, chooseSubsets(classById.get(classId)!, eventById, weeks, rand))
  }

  // --- Solve each week, reusing the single-week solver. ---
  const weekResults: PlanWeek[] = []
  const placementsByWeek = new Map<number, PlanPlacement[]>()
  for (const p of input.placements) {
    placementsByWeek.set(p.week, [...(placementsByWeek.get(p.week) ?? []), p])
  }

  const warnings: string[] = []
  for (let w = 1; w <= weeks; w++) {
    const weekPlacements = placementsByWeek.get(w) ?? []
    const locked = input.weekLocks[w - 1] === true

    if (locked) {
      // Untouched: keep every block exactly as it is.
      weekResults.push({
        week: w,
        placements: weekPlacements.map((p) => ({
          placementId: p.id,
          blocks: p.blocks
            .map(stripLock)
            .sort((a, b) => a.startMin - b.startMin || a.eventId - b.eventId),
        })),
      })
      continue
    }

    const weekSeed = Math.floor(rand() * 2 ** 31)
    const solved = solveWeek(
      w,
      weekPlacements,
      subsets,
      classById,
      solverEvents,
      input,
      weekSeed,
    )
    weekResults.push({ week: w, placements: solved.placements })
    if (solved.shortfall) {
      warnings.push(
        `Week ${w}: couldn't fit every planned event — some classes rotate through fewer this week.`,
      )
    }
  }

  // --- Coverage, counted from what was actually placed. ---
  const coverage = tallyCoverage(input, weekResults, classById, floor)
  for (const cls of coverage) {
    const className = classById.get(cls.classId)?.name ?? `class #${cls.classId}`
    for (const cov of cls.events) {
      if (cov.short) {
        const eventName = eventById.get(cov.eventId)?.name ?? `event #${cov.eventId}`
        warnings.push(
          `${eventName}: ${className} only gets ${cov.visits} of ${floor} visits across the plan.`,
        )
      }
    }
  }

  return {
    ok: true,
    seed: input.seed,
    weeks: weekResults,
    coverage,
    warnings: [...new Set(warnings)],
  }
}

/**
 * Pick each week's middle events for one class, evening out coverage. The
 * least-visited eligible events come first each week (so under-used ones are
 * preferred as the plan goes on), greedily filling the middle time. No event
 * is scheduled more than COVERAGE_TARGET_CAP times, so spare capacity spreads
 * rather than piling onto one apparatus.
 */
function chooseSubsets(
  cls: PlanClass,
  eventById: Map<number, PlanEvent>,
  weeks: number,
  rand: () => number,
): number[][] {
  const middle = cls.periodMinutes - cls.warmupMinutes - cls.cooldownMinutes
  const eligible = cls.eligibleEventIds.filter((id) => {
    const e = eventById.get(id)
    return e !== undefined && e.active && e.duration <= middle
  })
  const visits = new Map(eligible.map((id) => [id, 0]))
  const result: number[][] = []

  for (let w = 0; w < weeks; w++) {
    // Shuffle first so ties among equally-visited events break deterministically
    // but differently across seeds; then stable-sort by visits ascending.
    const ordered = shuffled(eligible, rand).sort((a, b) => visits.get(a)! - visits.get(b)!)
    let used = 0
    const chosen: number[] = []
    for (const id of ordered) {
      const duration = eventById.get(id)!.duration
      if (used + duration <= middle && visits.get(id)! < COVERAGE_TARGET_CAP) {
        chosen.push(id)
        used += duration
        visits.set(id, visits.get(id)! + 1)
      }
    }
    result.push(chosen)
  }
  return result
}

interface WeekSolveResult {
  placements: SolverPlacementResult[]
  /** True if events had to be dropped to make the week fit. */
  shortfall: boolean
}

/**
 * Solve one week via the single-week solver, dropping middle events on
 * contention until it fits. Warm-up and cool-down anchors and locked blocks
 * are always kept.
 */
function solveWeek(
  week: number,
  placements: PlanPlacement[],
  subsets: Map<number, number[][]>,
  classById: Map<number, PlanClass>,
  solverEvents: { id: number; name: string; capacity: number | null; active: boolean }[],
  input: PlanInput,
  seed: number,
): WeekSolveResult {
  // Mutable copy of this week's middle events per class, so we can trim.
  const middle = new Map<number, number[]>()
  for (const p of placements) {
    middle.set(p.id, [...(subsets.get(p.classId)?.[week - 1] ?? [])])
  }

  const durationOf = new Map(input.events.map((e) => [e.id, e.duration]))

  const buildInput = () => ({
    events: solverEvents,
    coaches: input.coaches,
    coachMode: input.coachMode,
    adjacencyPenalties: input.adjacencyPenalties,
    seed,
    // One solver class per placement: a class appears once per week, so its
    // requiredEvents (warm-up → this week's middle events → cool-down) are
    // unambiguous.
    classes: placements.map((p) => {
      const cls = classById.get(p.classId)!
      const required: {
        eventId: number
        duration: number
        position: 'FIRST' | 'ANY' | 'LAST'
      }[] = []
      if (cls.warmupEventId !== null && cls.warmupMinutes > 0) {
        required.push({ eventId: cls.warmupEventId, duration: cls.warmupMinutes, position: 'FIRST' })
      }
      for (const eventId of middle.get(p.id) ?? []) {
        const duration = durationOf.get(eventId) ?? 0
        if (duration > 0) required.push({ eventId, duration, position: 'ANY' })
      }
      if (cls.cooldownEventId !== null && cls.cooldownMinutes > 0) {
        required.push({ eventId: cls.cooldownEventId, duration: cls.cooldownMinutes, position: 'LAST' })
      }
      return {
        id: cls.id,
        name: cls.name,
        priority: cls.priority,
        requiredEvents: required,
        assignedCoaches: cls.assignedCoaches,
      }
    }),
    placements: placements.map((p) => ({
      id: p.id,
      classId: p.classId,
      startMin: p.startMin,
      endMin: p.endMin,
      locked: p.blocks.filter((b) => b.locked).map(stripLock),
    })),
  })

  let dropped = false
  // Bounded retries: each failure trims one middle event from the class with
  // the most this week, shrinking contention until the week fits (or only the
  // anchors remain, which always fit if the window holds them).
  const totalMiddle = () => [...middle.values()].reduce((n, list) => n + list.length, 0)
  for (let attempt = 0; attempt <= totalMiddle() + 1; attempt++) {
    const result = generateSchedule(buildInput())
    if (result.ok) {
      return { placements: result.placements, shortfall: dropped }
    }
    // Trim the busiest class's last (least-needed) middle event and retry.
    const busiest = [...middle.entries()]
      .filter(([, list]) => list.length > 0)
      .sort((a, b) => b[1].length - a[1].length)[0]
    if (!busiest) break
    busiest[1].pop()
    dropped = true
  }

  // Even the anchors wouldn't fit: leave the week's unlocked lanes empty but
  // keep any locked blocks, so nothing hand-locked is lost.
  return {
    placements: placements.map((p) => ({
      placementId: p.id,
      blocks: p.blocks
        .filter((b) => b.locked)
        .map(stripLock)
        .sort((a, b) => a.startMin - b.startMin || a.eventId - b.eventId),
    })),
    shortfall: true,
  }
}

/** Count each eligible event's actual visits per class across every week. */
function tallyCoverage(
  input: PlanInput,
  weeks: PlanWeek[],
  classById: Map<number, PlanClass>,
  floor: number,
): ClassCoverage[] {
  const placementClass = new Map(input.placements.map((p) => [p.id, p.classId]))
  // classId → eventId → visits
  const counts = new Map<number, Map<number, number>>()
  for (const cls of classById.values()) {
    counts.set(cls.id, new Map(cls.eligibleEventIds.map((id) => [id, 0])))
  }
  for (const week of weeks) {
    for (const pr of week.placements) {
      const classId = placementClass.get(pr.placementId)
      if (classId === undefined) continue
      const byEvent = counts.get(classId)
      if (!byEvent) continue
      for (const b of pr.blocks) {
        // Only eligible (middle) events count toward coverage — anchors don't.
        if (byEvent.has(b.eventId)) byEvent.set(b.eventId, byEvent.get(b.eventId)! + 1)
      }
    }
  }

  return [...classById.values()].map((cls): ClassCoverage => {
    const byEvent = counts.get(cls.id)!
    const events: EventCoverage[] = cls.eligibleEventIds.map((eventId) => {
      const visits = byEvent.get(eventId) ?? 0
      return { eventId, visits, short: visits < floor }
    })
    return { classId: cls.id, events }
  })
}

const stripLock = (b: PlanBlock): SolverBlock => ({
  eventId: b.eventId,
  coachId: b.coachId,
  startMin: b.startMin,
  endMin: b.endMin,
})
