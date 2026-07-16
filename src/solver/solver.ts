// Rotation schedule generator: greedy placement in class-priority order
// with block-level backtracking, deterministic for a given seed.
//
// This is the *primary* way a schedule gets made: a gym enters its structure
// once and generates from it. Each class's required events are filled inside
// that class's own window, honouring their position anchors, and everything
// already locked is left exactly as it is.
//
// Hard constraints (never violated in an ok result):
//   1. An event's simultaneous classes never exceed its capacity
//      (a null capacity is unlimited).
//   2. A class is in exactly one place per slot. Structural: a placement's
//      blocks never overlap each other.
//   3. A coach is in exactly one place per slot.
//   4. Every required event is fulfilled with its full duration.
//   5. Inactive events are never scheduled.
//   6. No block escapes its placement's window.
//   7. Position anchors hold: every FIRST event precedes every ANY and LAST,
//      and every LAST follows every FIRST and ANY.
// Soft constraints (heuristic candidate ordering, in priority order):
//   higher-priority classes place first; minimize idle time inside each
//   window; avoid configured bad back-to-back event pairs; keep coaches
//   with their assigned class (or event, per coach mode).
import { SLOT_MINUTES, formatRange } from '../../shared/slots.ts'
import { mulberry32, shuffled } from './rng.ts'
import type {
  EventPosition,
  SolverBlock,
  SolverClass,
  SolverEvent,
  SolverInput,
  SolverPlacement,
  SolverResult,
} from './types.ts'

const NODE_BUDGET = 200_000
const MAX_CANDIDATES_PER_BLOCK = 64
const ADJACENCY_PENALTY_SCORE = 5

/** Absolute minutes → slot index. The day is small enough to index flat. */
const SLOTS_PER_DAY = (24 * 60) / SLOT_MINUTES
const slotOf = (minutes: number) => minutes / SLOT_MINUTES

interface Need {
  placement: SolverPlacement
  cls: SolverClass
  eventId: number
  /** Contiguous slots still to place (locks may cover part of a need). */
  length: number
  position: EventPosition
}

interface Placed {
  need: Need
  startSlot: number
}

export function generateSchedule(input: SolverInput): SolverResult {
  const reasons = feasibilityReasons(input)
  if (reasons.length > 0) return { ok: false, reasons }

  const rand = mulberry32(input.seed)
  const eventById = new Map(input.events.map((e) => [e.id, e]))
  const classById = new Map(input.classes.map((c) => [c.id, c]))

  // Occupancy, seeded with everything already painted and locked.
  // eventUse counts simultaneous classes per event; busy marks a placement's
  // own slots; at records which event a placement is on, for adjacency.
  const eventUse = new Map<number, Uint16Array>(
    input.events.map((e) => [e.id, new Uint16Array(SLOTS_PER_DAY)]),
  )
  const busy = new Map<number, Uint8Array>(
    input.placements.map((p) => [p.id, new Uint8Array(SLOTS_PER_DAY)]),
  )
  const at = new Map<number, Int32Array>(
    input.placements.map((p) => [p.id, new Int32Array(SLOTS_PER_DAY).fill(-1)]),
  )
  for (const p of input.placements) {
    for (const b of p.locked) {
      for (let s = slotOf(b.startMin); s < slotOf(b.endMin); s++) {
        eventUse.get(b.eventId)![s]!++
        busy.get(p.id)![s] = 1
        at.get(p.id)![s] = b.eventId
      }
    }
  }

  // What remains to place, after locks are credited against requirements.
  //
  // Ordering matters twice over. Across classes, higher priority first.
  // Within a class, FIRST needs are placed before ANY, and ANY before LAST:
  // that ordering is what makes the anchors enforceable, because each need
  // is then only ever bounded below by what is already down (see
  // earliestSlot). Longest-first inside each group — hardest to fit.
  const RANK: Record<EventPosition, number> = { FIRST: 0, ANY: 1, LAST: 2 }
  const needs: Need[] = []
  for (const placement of prioritized(input.placements, classById, rand)) {
    const cls = classById.get(placement.classId)
    if (!cls) continue
    const perClass: Need[] = []
    for (const req of cls.requiredEvents) {
      const requiredSlots = req.duration / SLOT_MINUTES
      const lockedSlots = placement.locked
        .filter((b) => b.eventId === req.eventId)
        .reduce((sum, b) => sum + slotOf(b.endMin) - slotOf(b.startMin), 0)
      const remaining = requiredSlots - lockedSlots
      if (remaining > 0) {
        perClass.push({
          placement,
          cls,
          eventId: req.eventId,
          length: remaining,
          position: req.position,
        })
      }
    }
    perClass.sort((a, b) => RANK[a.position] - RANK[b.position] || b.length - a.length)
    needs.push(...perClass)
  }

  /**
   * The earliest slot a need may start at, given its anchor and what its
   * class already has down. A FIRST need is free (it leads); an ANY need
   * must clear every FIRST block; a LAST need must clear everything else.
   * Locked blocks count too — a hand-placed warm-up still leads.
   */
  const earliestSlot = (need: Need): number => {
    const first = slotOf(need.placement.startMin)
    if (need.position === 'FIRST') return first
    const anchorOf = new Map(need.cls.requiredEvents.map((r) => [r.eventId, r.position]))
    const mustClear = (b: { eventId: number; endMin: number }) => {
      const at = anchorOf.get(b.eventId) ?? 'ANY'
      return need.position === 'LAST' ? at !== 'LAST' : at === 'FIRST'
    }
    let earliest = first
    for (const b of need.placement.locked) {
      if (mustClear(b)) earliest = Math.max(earliest, slotOf(b.endMin))
    }
    for (const p of placed) {
      if (p.need.placement.id !== need.placement.id) continue
      const at = p.need.position
      const blocks = need.position === 'LAST' ? at !== 'LAST' : at === 'FIRST'
      if (blocks) earliest = Math.max(earliest, p.startSlot + p.need.length)
    }
    return earliest
  }

  const adjacencyBad = new Set(
    input.adjacencyPenalties.map((p) => `${p.beforeEventId}:${p.afterEventId}`),
  )

  const placed: Placed[] = []
  let nodes = 0
  let budgetExceeded = false
  let deepest = -1

  const apply = (need: Need, startSlot: number) => {
    const use = eventUse.get(need.eventId)!
    const b = busy.get(need.placement.id)!
    const a = at.get(need.placement.id)!
    for (let s = startSlot; s < startSlot + need.length; s++) {
      use[s]!++
      b[s] = 1
      a[s] = need.eventId
    }
    placed.push({ need, startSlot })
  }

  const undo = () => {
    const { need, startSlot } = placed.pop()!
    const use = eventUse.get(need.eventId)!
    const b = busy.get(need.placement.id)!
    const a = at.get(need.placement.id)!
    for (let s = startSlot; s < startSlot + need.length; s++) {
      use[s]!--
      b[s] = 0
      a[s] = -1
    }
  }

  const candidateStarts = (need: Need): number[] => {
    const event = eventById.get(need.eventId)!
    const capacity = event.capacity ?? Infinity
    const use = eventUse.get(need.eventId)!
    const b = busy.get(need.placement.id)!
    const a = at.get(need.placement.id)!
    // Candidates live strictly inside the class's own window, and no
    // earlier than the class's anchors allow.
    const first = slotOf(need.placement.startMin)
    const last = slotOf(need.placement.endMin)
    const from = earliestSlot(need)
    const starts: { start: number; score: number }[] = []
    outer: for (let start = from; start + need.length <= last; start++) {
      for (let s = start; s < start + need.length; s++) {
        if (use[s]! >= capacity || b[s]! === 1) continue outer
      }
      // Idle heuristic: prefer starts adjacent to what the class already
      // has; a class with nothing placed packs toward its window's start.
      let prevBusy = -1
      for (let s = start - 1; s >= first; s--) {
        if (b[s] === 1) {
          prevBusy = s
          break
        }
      }
      let nextBusy = -1
      for (let s = start + need.length; s < last; s++) {
        if (b[s] === 1) {
          nextBusy = s
          break
        }
      }
      const gapBefore = prevBusy === -1 ? start - first : start - prevBusy - 1
      const gapAfter = nextBusy === -1 ? Number.MAX_SAFE_INTEGER : nextBusy - (start + need.length)
      let score = Math.min(gapBefore, gapAfter === Number.MAX_SAFE_INTEGER ? gapBefore : gapAfter)

      // Configured bad back-to-back pairs.
      const before = start > first ? a[start - 1]! : -1
      const after = start + need.length < last ? a[start + need.length]! : -1
      if (before !== -1 && adjacencyBad.has(`${before}:${need.eventId}`)) {
        score += ADJACENCY_PENALTY_SCORE
      }
      if (after !== -1 && adjacencyBad.has(`${need.eventId}:${after}`)) {
        score += ADJACENCY_PENALTY_SCORE
      }

      starts.push({ start, score: score + rand() * 0.9 })
    }
    starts.sort((x, y) => x.score - y.score)
    return starts.slice(0, MAX_CANDIDATES_PER_BLOCK).map((s) => s.start)
  }

  const place = (i: number): boolean => {
    if (i === needs.length) return true
    if (++nodes > NODE_BUDGET) {
      budgetExceeded = true
      return false
    }
    if (i > deepest) deepest = i
    for (const start of candidateStarts(needs[i]!)) {
      apply(needs[i]!, start)
      if (place(i + 1)) return true
      undo()
      if (budgetExceeded) return false
    }
    return false
  }

  if (!place(0)) {
    const stuck = needs[Math.min(deepest + 1, needs.length - 1)]
    const where = stuck
      ? `${stuck.cls.name}'s ${eventName(input.events, stuck.eventId)} in its ${formatRange(stuck.placement.startMin, stuck.placement.endMin)} window`
      : 'the schedule'
    return {
      ok: false,
      reasons: [
        budgetExceeded
          ? `Couldn't find a valid arrangement in time — got stuck placing ${where}. Try a different seed, a longer window, or fewer required events.`
          : `No conflict-free arrangement exists — couldn't place ${where}. Try widening the class's window, raising event capacity, or asking for fewer required events.`,
      ],
    }
  }

  // Expand placements into blocks, then staff them.
  const generated = new Map<number, SolverBlock[]>(input.placements.map((p) => [p.id, []]))
  for (const { need, startSlot } of placed) {
    generated.get(need.placement.id)!.push({
      eventId: need.eventId,
      coachId: null,
      startMin: startSlot * SLOT_MINUTES,
      endMin: (startSlot + need.length) * SLOT_MINUTES,
    })
  }
  assignCoaches(input, generated, rand)

  return {
    ok: true,
    seed: input.seed,
    placements: input.placements.map((p) => ({
      placementId: p.id,
      blocks: [...p.locked, ...generated.get(p.id)!].sort(
        (a, b) => a.startMin - b.startMin || a.eventId - b.eventId,
      ),
    })),
  }
}

/** Class-priority order, seeded shuffle within equal priority. */
function prioritized(
  placements: SolverPlacement[],
  classById: Map<number, SolverClass>,
  rand: () => number,
): SolverPlacement[] {
  return shuffled(placements, rand).sort(
    (a, b) =>
      (classById.get(b.classId)?.priority ?? 0) - (classById.get(a.classId)?.priority ?? 0),
  )
}

function eventName(events: SolverEvent[], id: number): string {
  return events.find((e) => e.id === id)?.name ?? `event #${id}`
}

/**
 * Soft constraint: coaches stay with their class (class mode) or own an
 * event (event mode). Never double-books a coach — hard constraint 3 holds
 * by construction; when the preferred coach is busy the block gets none.
 */
function assignCoaches(
  input: SolverInput,
  generated: Map<number, SolverBlock[]>,
  rand: () => number,
): void {
  // coach id → slot → event id they are at.
  const coachAt = new Map<number, Int32Array>(
    input.coaches.map((c) => [c.id, new Int32Array(SLOTS_PER_DAY).fill(-1)]),
  )
  for (const p of input.placements) {
    for (const b of p.locked) {
      if (b.coachId === null) continue
      const at = coachAt.get(b.coachId)
      if (!at) continue
      for (let s = slotOf(b.startMin); s < slotOf(b.endMin); s++) at[s] = b.eventId
    }
  }

  const classById = new Map(input.classes.map((c) => [c.id, c]))
  const tryAssign = (block: SolverBlock, coachId: number): boolean => {
    const at = coachAt.get(coachId)
    if (!at) return false
    for (let s = slotOf(block.startMin); s < slotOf(block.endMin); s++) {
      // Free, or already at this same event (one physical place) — allowed.
      if (at[s]! !== -1 && at[s]! !== block.eventId) return false
    }
    for (let s = slotOf(block.startMin); s < slotOf(block.endMin); s++) at[s] = block.eventId
    block.coachId = coachId
    return true
  }

  if (input.coachMode === 'class') {
    for (const p of input.placements) {
      const prefs = classById.get(p.classId)?.assignedCoaches ?? []
      for (const block of generated.get(p.id) ?? []) {
        for (const coachId of prefs) {
          if (tryAssign(block, coachId)) break
        }
      }
    }
    return
  }

  // Event mode: designate one specialist per used event (spreading coaches
  // across events), then staff each block with its event's designee.
  const all = [...generated.values()].flat()
  const usedEventIds = [...new Set(all.map((b) => b.eventId))]
  const designations = new Map<number, number>()
  const load = new Map<number, number>(input.coaches.map((c) => [c.id, 0]))
  for (const eventId of shuffled(usedEventIds, rand)) {
    const specialists = input.coaches.filter((c) => c.specialties.includes(eventId))
    if (specialists.length === 0) continue
    const chosen = specialists.reduce((best, c) => (load.get(c.id)! < load.get(best.id)! ? c : best))
    designations.set(eventId, chosen.id)
    load.set(chosen.id, load.get(chosen.id)! + 1)
  }
  for (const block of all) {
    const designated = designations.get(block.eventId)
    if (designated !== undefined) tryAssign(block, designated)
  }
}

/** All infeasibility explanations, reported together, per class window. */
function feasibilityReasons(input: SolverInput): string[] {
  const reasons: string[] = []
  const eventById = new Map(input.events.map((e) => [e.id, e]))
  const classById = new Map(input.classes.map((c) => [c.id, c]))

  if (input.placements.length === 0) {
    return ['No classes are placed yet — add a class to a column first.']
  }

  // Per-placement demand against that class's own window.
  const demand = new Map<string, number>() // `${placementId}:${eventId}` → slots
  for (const p of input.placements) {
    const cls = classById.get(p.classId)
    if (!cls) continue
    const windowSlots = (p.endMin - p.startMin) / SLOT_MINUTES
    const windowMin = p.endMin - p.startMin
    if (windowSlots <= 0) {
      reasons.push(`${cls.name}'s window has no time in it.`)
      continue
    }

    let totalSlots = 0
    for (const req of cls.requiredEvents) {
      const event = eventById.get(req.eventId)
      if (!event) {
        reasons.push(`${cls.name} requires an event that no longer exists.`)
        continue
      }
      if (!event.active) {
        reasons.push(`${cls.name} requires ${event.name}, which is marked inactive.`)
        continue
      }
      if (req.duration <= 0 || req.duration % SLOT_MINUTES !== 0) {
        reasons.push(
          `${cls.name}'s ${req.duration} min on ${event.name} isn't a multiple of ${SLOT_MINUTES} minutes.`,
        )
        continue
      }
      if (req.duration > windowMin) {
        reasons.push(
          `${cls.name} needs ${req.duration} min on ${event.name} but its window is only ${windowMin} min (${formatRange(p.startMin, p.endMin)}).`,
        )
      }
      demand.set(`${p.id}:${req.eventId}`, req.duration / SLOT_MINUTES)
      totalSlots += req.duration / SLOT_MINUTES
    }

    // Locked blocks on events outside the requirements still eat the window.
    const extraLocked = cls.requiredEvents.length
      ? p.locked
          .filter((b) => !cls.requiredEvents.some((r) => r.eventId === b.eventId))
          .reduce((sum, b) => sum + (b.endMin - b.startMin) / SLOT_MINUTES, 0)
      : 0
    if (totalSlots + extraLocked > windowSlots) {
      reasons.push(
        `${cls.name} needs ${(totalSlots + extraLocked) * SLOT_MINUTES} min of events but its window is only ${windowMin} min (${formatRange(p.startMin, p.endMin)}).`,
      )
    }
  }

  // Aggregate event demand against capacity, over the span it's contested.
  for (const event of input.events) {
    if (!event.active || event.capacity === null) continue
    let needed = 0
    for (const p of input.placements) {
      needed += demand.get(`${p.id}:${event.id}`) ?? 0
    }
    if (needed === 0) continue
    // The widest span any placement needing it could use.
    const users = input.placements.filter((p) => (demand.get(`${p.id}:${event.id}`) ?? 0) > 0)
    const spanStart = Math.min(...users.map((p) => p.startMin))
    const spanEnd = Math.max(...users.map((p) => p.endMin))
    const spanSlots = (spanEnd - spanStart) / SLOT_MINUTES
    if (needed > spanSlots * event.capacity) {
      // Name the count: a shared apparatus being over-subscribed is the
      // most common way a gym's structure fails, and "5 classes" is what
      // makes it actionable.
      reasons.push(
        `${event.name} is over-subscribed: ${users.length} class${users.length === 1 ? '' : 'es'} need ${needed * SLOT_MINUTES} min on it between ${formatRange(spanStart, spanEnd)}, which only fits ${spanSlots * event.capacity * SLOT_MINUTES} min.`,
      )
    }
  }

  // Locked blocks must themselves be legal.
  for (const p of input.placements) {
    const cls = classById.get(p.classId)
    for (const b of p.locked) {
      const event = eventById.get(b.eventId)
      if (b.startMin < p.startMin || b.endMin > p.endMin) {
        reasons.push(
          `${cls?.name ?? 'A class'} has a locked block outside its ${formatRange(p.startMin, p.endMin)} window.`,
        )
        continue
      }
      if (!event) {
        reasons.push('A locked block references an event that no longer exists.')
        continue
      }
      if (!event.active) {
        reasons.push(`${event.name} is inactive but has a locked block at ${formatRange(b.startMin, b.endMin)}.`)
      }
    }
  }

  return [...new Set(reasons)]
}
