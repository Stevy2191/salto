// Rotation schedule generator: greedy placement in priority order with
// block-level backtracking, deterministic for a given seed.
//
// Hard constraints (never violated in an ok result):
//   1. An event's simultaneous classes never exceed its capacity.
//   2. A class is in exactly one place per slot.
//   3. A coach is in exactly one place per slot.
//   4. Every required event is fulfilled with its full duration.
//   5. Inactive events are never scheduled.
// Soft constraints (heuristic candidate ordering, in priority order):
//   higher-priority classes place first; minimize idle slots per class;
//   avoid configured bad back-to-back event pairs; keep coaches with
//   their assigned class (or event, per coach mode).
import type { Assignment } from '../../shared/types.ts'
import { mulberry32, shuffled } from './rng.ts'
import type {
  SolverClass,
  SolverCoach,
  SolverEvent,
  SolverInput,
  SolverResult,
} from './types.ts'

const NODE_BUDGET = 200_000
const MAX_CANDIDATES_PER_BLOCK = 64
const ADJACENCY_PENALTY_SCORE = 5

interface Block {
  cls: SolverClass
  eventId: number
  /** Contiguous slots still to place (locks may cover part of a requirement). */
  length: number
}

interface Placement {
  block: Block
  start: number
}

const slotLabel = (slotIndex: number) => `rotation ${slotIndex + 1}`

export function generateSchedule(input: SolverInput): SolverResult {
  const reasons = feasibilityReasons(input)
  if (reasons.length > 0) return { ok: false, reasons }

  const rand = mulberry32(input.seed)
  const S = input.slotCount
  const eventById = new Map(input.events.map((e) => [e.id, e]))

  // Occupancy state, seeded with the locked assignments.
  const eventUse = new Map<number, Uint8Array>(input.events.map((e) => [e.id, new Uint8Array(S)]))
  const classBusy = new Map<number, Uint8Array>(input.classes.map((c) => [c.id, new Uint8Array(S)]))
  const classEventAt = new Map<number, Int32Array>(
    input.classes.map((c) => [c.id, new Int32Array(S).fill(-1)]),
  )
  for (const lock of input.locked) {
    eventUse.get(lock.eventId)![lock.slotIndex]++
    const busy = classBusy.get(lock.classId)
    if (busy) {
      busy[lock.slotIndex] = 1
      classEventAt.get(lock.classId)![lock.slotIndex] = lock.eventId
    }
  }

  // Blocks: what remains to place after locks are credited to requirements.
  const blocks: Block[] = []
  for (const cls of prioritized(input.classes, rand)) {
    const classBlocks: Block[] = []
    for (const req of cls.requiredEvents) {
      const requiredSlots = req.duration / input.rotationLength
      const lockedSlots = input.locked.filter(
        (l) => l.classId === cls.id && l.eventId === req.eventId,
      ).length
      const remaining = requiredSlots - lockedSlots
      if (remaining > 0) classBlocks.push({ cls, eventId: req.eventId, length: remaining })
    }
    // Longest blocks first within a class — hardest to fit.
    classBlocks.sort((a, b) => b.length - a.length)
    blocks.push(...classBlocks)
  }

  const adjacencyBad = new Set(
    input.adjacencyPenalties.map((p) => `${p.beforeEventId}:${p.afterEventId}`),
  )

  const placements: Placement[] = []
  let nodes = 0
  let budgetExceeded = false
  let deepestBlock = -1

  const apply = (block: Block, start: number) => {
    const use = eventUse.get(block.eventId)!
    const busy = classBusy.get(block.cls.id)!
    const at = classEventAt.get(block.cls.id)!
    for (let t = start; t < start + block.length; t++) {
      use[t]++
      busy[t] = 1
      at[t] = block.eventId
    }
    placements.push({ block, start })
  }

  const undo = () => {
    const { block, start } = placements.pop()!
    const use = eventUse.get(block.eventId)!
    const busy = classBusy.get(block.cls.id)!
    const at = classEventAt.get(block.cls.id)!
    for (let t = start; t < start + block.length; t++) {
      use[t]--
      busy[t] = 0
      at[t] = -1
    }
  }

  const candidateStarts = (block: Block): number[] => {
    const event = eventById.get(block.eventId)!
    const use = eventUse.get(block.eventId)!
    const busy = classBusy.get(block.cls.id)!
    const at = classEventAt.get(block.cls.id)!
    const starts: { start: number; score: number }[] = []
    outer: for (let start = 0; start + block.length <= S; start++) {
      for (let t = start; t < start + block.length; t++) {
        if (use[t]! >= event.capacity || busy[t]! === 1) continue outer
      }
      // Idle heuristic: prefer starts adjacent to the class's existing
      // blocks; a class with nothing placed prefers packing early.
      let prevBusy = -1
      for (let t = start - 1; t >= 0; t--) {
        if (busy[t] === 1) {
          prevBusy = t
          break
        }
      }
      let nextBusy = -1
      for (let t = start + block.length; t < S; t++) {
        if (busy[t] === 1) {
          nextBusy = t
          break
        }
      }
      const gapBefore = prevBusy === -1 ? start : start - prevBusy - 1
      const gapAfter = nextBusy === -1 ? Number.MAX_SAFE_INTEGER : nextBusy - (start + block.length)
      let score = Math.min(gapBefore, gapAfter === Number.MAX_SAFE_INTEGER ? gapBefore : gapAfter)

      // Configured bad back-to-back pairs.
      const before = start > 0 ? at[start - 1]! : -1
      const after = start + block.length < S ? at[start + block.length]! : -1
      if (before !== -1 && adjacencyBad.has(`${before}:${block.eventId}`)) {
        score += ADJACENCY_PENALTY_SCORE
      }
      if (after !== -1 && adjacencyBad.has(`${block.eventId}:${after}`)) {
        score += ADJACENCY_PENALTY_SCORE
      }

      starts.push({ start, score: score + rand() * 0.9 })
    }
    starts.sort((a, b) => a.score - b.score)
    return starts.slice(0, MAX_CANDIDATES_PER_BLOCK).map((s) => s.start)
  }

  const place = (i: number): boolean => {
    if (i === blocks.length) return true
    if (++nodes > NODE_BUDGET) {
      budgetExceeded = true
      return false
    }
    if (i > deepestBlock) deepestBlock = i
    for (const start of candidateStarts(blocks[i]!)) {
      apply(blocks[i]!, start)
      if (place(i + 1)) return true
      undo()
      if (budgetExceeded) return false
    }
    return false
  }

  if (!place(0)) {
    const stuck = blocks[Math.min(deepestBlock + 1, blocks.length - 1)]
    const stuckName = stuck ? `${stuck.cls.name}'s ${eventName(input.events, stuck.eventId)}` : 'the schedule'
    return {
      ok: false,
      reasons: [
        budgetExceeded
          ? `Couldn't find a valid arrangement in time — got stuck placing ${stuckName}. Try a different seed, a longer session, or fewer required events.`
          : `No conflict-free arrangement exists for these requirements — couldn't place ${stuckName}. Try a longer session, higher event capacity, or fewer required events.`,
      ],
    }
  }

  // Expand block placements into per-slot assignments, then assign coaches.
  const generated: Assignment[] = []
  for (const { block, start } of placements) {
    for (let t = start; t < start + block.length; t++) {
      generated.push({
        slotIndex: t,
        eventId: block.eventId,
        classId: block.cls.id,
        coachId: null,
        locked: false,
      })
    }
  }
  assignCoaches(input, generated, rand)

  const assignments = [
    ...input.locked.map((l) => ({ ...l, locked: true })),
    ...generated,
  ].sort(
    (a, b) => a.slotIndex - b.slotIndex || a.eventId - b.eventId || a.classId - b.classId,
  )
  return { ok: true, assignments, seed: input.seed }
}

/** Priority order, seeded shuffle within equal priority. */
function prioritized(classes: SolverClass[], rand: () => number): SolverClass[] {
  return shuffled(classes, rand).sort((a, b) => b.priority - a.priority)
}

function eventName(events: SolverEvent[], id: number): string {
  return events.find((e) => e.id === id)?.name ?? `event #${id}`
}

/**
 * Soft constraint: coaches stay with their class (class mode) or own an
 * event (event mode). Never double-books a coach — hard constraint 3 holds
 * by construction; when the preferred coach is busy the cell gets no coach.
 */
function assignCoaches(input: SolverInput, generated: Assignment[], rand: () => number): void {
  // coach id → slot → event id they are at.
  const coachAt = new Map<number, Int32Array>(
    input.coaches.map((c) => [c.id, new Int32Array(input.slotCount).fill(-1)]),
  )
  for (const lock of input.locked) {
    if (lock.coachId !== null) {
      coachAt.get(lock.coachId)?.fill(lock.eventId, lock.slotIndex, lock.slotIndex + 1)
    }
  }

  const classById = new Map(input.classes.map((c) => [c.id, c]))
  const tryAssign = (a: Assignment, coachId: number): boolean => {
    const at = coachAt.get(coachId)
    if (!at) return false
    const current = at[a.slotIndex]!
    // Free, or already at this same event (one physical place) — allowed.
    if (current !== -1 && current !== a.eventId) return false
    at[a.slotIndex] = a.eventId
    a.coachId = coachId
    return true
  }

  if (input.coachMode === 'class') {
    for (const a of generated) {
      const prefs = classById.get(a.classId)?.assignedCoaches ?? []
      for (const coachId of prefs) {
        if (tryAssign(a, coachId)) break
      }
    }
    return
  }

  // Event mode: designate one specialist per used event (spreading coaches
  // across events), then staff each cell with its event's designee.
  const usedEventIds = [...new Set(generated.map((a) => a.eventId))]
  const designations = new Map<number, number>()
  const load = new Map<number, number>(input.coaches.map((c) => [c.id, 0]))
  for (const eventId of shuffled(usedEventIds, rand)) {
    const specialists = input.coaches.filter((c) => c.specialties.includes(eventId))
    if (specialists.length === 0) continue
    const chosen = specialists.reduce((best, c) =>
      load.get(c.id)! < load.get(best.id)! ? c : best,
    )
    designations.set(eventId, chosen.id)
    load.set(chosen.id, load.get(chosen.id)! + 1)
  }
  for (const a of generated) {
    const designated = designations.get(a.eventId)
    if (designated !== undefined) tryAssign(a, designated)
  }
}

/** All infeasibility explanations, reported together. */
function feasibilityReasons(input: SolverInput): string[] {
  const reasons: string[] = []
  const S = input.slotCount
  const rot = input.rotationLength
  const eventById = new Map(input.events.map((e) => [e.id, e]))
  const minutes = (slots: number) => slots * rot

  if (S <= 0) {
    reasons.push('The session window has no rotation slots — check its start/end times.')
    return reasons
  }

  // Requirements.
  const requiredSlots = new Map<string, number>() // `${classId}:${eventId}` → slots
  for (const cls of input.classes) {
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
      if (req.duration <= 0 || req.duration % rot !== 0) {
        reasons.push(
          `${cls.name}'s ${req.duration} min on ${event.name} isn't a multiple of the ${rot}-min rotation.`,
        )
        continue
      }
      const slots = req.duration / rot
      if (slots > S) {
        reasons.push(
          `${cls.name} needs ${req.duration} min on ${event.name} but the session is only ${minutes(S)} min.`,
        )
      }
      requiredSlots.set(`${cls.id}:${req.eventId}`, slots)
      totalSlots += slots
    }
    // Locked cells on events outside the requirements still occupy the class.
    const extraLocked = input.locked.filter(
      (l) =>
        l.classId === cls.id && !cls.requiredEvents.some((r) => r.eventId === l.eventId),
    ).length
    if (totalSlots + extraLocked > S) {
      reasons.push(
        `${cls.name} needs ${minutes(totalSlots + extraLocked)} min of events but the session is only ${minutes(S)} min.`,
      )
    }
  }

  // Aggregate event demand vs capacity.
  for (const event of input.events) {
    if (!event.active) continue
    let demand = 0
    for (const cls of input.classes) {
      demand += requiredSlots.get(`${cls.id}:${event.id}`) ?? 0
    }
    demand += input.locked.filter(
      (l) =>
        l.eventId === event.id &&
        !requiredSlots.has(`${l.classId}:${event.id}`),
    ).length
    if (demand > S * event.capacity) {
      reasons.push(
        `${event.name} is overbooked: classes need ${minutes(demand)} min on it but it only fits ${minutes(S * event.capacity)} min.`,
      )
    }
  }

  // Locks must themselves be legal.
  const lockUse = new Map<string, number>()
  const lockClassAt = new Map<string, number>()
  const lockCoachAt = new Map<string, number>()
  for (const lock of input.locked) {
    const event = eventById.get(lock.eventId)
    if (lock.slotIndex < 0 || lock.slotIndex >= S) {
      reasons.push(`A locked assignment sits outside the session window (${slotLabel(lock.slotIndex)}).`)
      continue
    }
    if (!event) {
      reasons.push('A locked assignment references an event that no longer exists.')
      continue
    }
    if (!event.active) {
      reasons.push(`${event.name} is inactive but has a locked assignment at ${slotLabel(lock.slotIndex)}.`)
    }
    const useKey = `${lock.eventId}:${lock.slotIndex}`
    lockUse.set(useKey, (lockUse.get(useKey) ?? 0) + 1)
    if (lockUse.get(useKey)! > event.capacity) {
      reasons.push(
        `${event.name} has more locked classes than its capacity of ${event.capacity} at ${slotLabel(lock.slotIndex)}.`,
      )
    }
    const classKey = `${lock.classId}:${lock.slotIndex}`
    const prevEvent = lockClassAt.get(classKey)
    if (prevEvent !== undefined && prevEvent !== lock.eventId) {
      const cls = input.classes.find((c) => c.id === lock.classId)
      reasons.push(
        `${cls?.name ?? 'A class'} is locked in two places at ${slotLabel(lock.slotIndex)}.`,
      )
    }
    lockClassAt.set(classKey, lock.eventId)
    if (lock.coachId !== null) {
      const coachKey = `${lock.coachId}:${lock.slotIndex}`
      const prevCoachEvent = lockCoachAt.get(coachKey)
      if (prevCoachEvent !== undefined && prevCoachEvent !== lock.eventId) {
        const coach = coachNameById(input.coaches, lock.coachId)
        reasons.push(`${coach} is locked in two places at ${slotLabel(lock.slotIndex)}.`)
      }
      lockCoachAt.set(coachKey, lock.eventId)
    }
  }

  return [...new Set(reasons)]
}

function coachNameById(coaches: SolverCoach[], id: number): string {
  return coaches.find((c) => c.id === id)?.name ?? `coach #${id}`
}
