// Rotation schedule generator: greedy placement in priority order with
// block-level backtracking, deterministic for a given seed.
//
// Hard constraints (never violated in an ok result):
//   1. An event's simultaneous groups never exceed its capacity.
//   2. A group is in exactly one place per slot.
//   3. A coach is in exactly one place per slot.
//   4. Every required event is fulfilled with its full duration.
//   5. Inactive events are never scheduled.
// Soft constraints (heuristic candidate ordering, in priority order):
//   higher-priority groups place first; minimize idle slots per group;
//   avoid configured bad back-to-back event pairs; keep coaches with
//   their assigned group (or event, per coach mode).
import type { Assignment } from '../../shared/types.ts'
import { mulberry32, shuffled } from './rng.ts'
import type {
  SolverCoach,
  SolverEvent,
  SolverGroup,
  SolverInput,
  SolverResult,
} from './types.ts'

const NODE_BUDGET = 200_000
const MAX_CANDIDATES_PER_BLOCK = 64
const ADJACENCY_PENALTY_SCORE = 5

interface Block {
  group: SolverGroup
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
  const groupBusy = new Map<number, Uint8Array>(input.groups.map((g) => [g.id, new Uint8Array(S)]))
  const groupEventAt = new Map<number, Int32Array>(
    input.groups.map((g) => [g.id, new Int32Array(S).fill(-1)]),
  )
  for (const lock of input.locked) {
    eventUse.get(lock.eventId)![lock.slotIndex]++
    const busy = groupBusy.get(lock.groupId)
    if (busy) {
      busy[lock.slotIndex] = 1
      groupEventAt.get(lock.groupId)![lock.slotIndex] = lock.eventId
    }
  }

  // Blocks: what remains to place after locks are credited to requirements.
  const blocks: Block[] = []
  for (const group of prioritized(input.groups, rand)) {
    const groupBlocks: Block[] = []
    for (const req of group.requiredEvents) {
      const requiredSlots = req.duration / input.rotationLength
      const lockedSlots = input.locked.filter(
        (l) => l.groupId === group.id && l.eventId === req.eventId,
      ).length
      const remaining = requiredSlots - lockedSlots
      if (remaining > 0) groupBlocks.push({ group, eventId: req.eventId, length: remaining })
    }
    // Longest blocks first within a group — hardest to fit.
    groupBlocks.sort((a, b) => b.length - a.length)
    blocks.push(...groupBlocks)
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
    const busy = groupBusy.get(block.group.id)!
    const at = groupEventAt.get(block.group.id)!
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
    const busy = groupBusy.get(block.group.id)!
    const at = groupEventAt.get(block.group.id)!
    for (let t = start; t < start + block.length; t++) {
      use[t]--
      busy[t] = 0
      at[t] = -1
    }
  }

  const candidateStarts = (block: Block): number[] => {
    const event = eventById.get(block.eventId)!
    const use = eventUse.get(block.eventId)!
    const busy = groupBusy.get(block.group.id)!
    const at = groupEventAt.get(block.group.id)!
    const starts: { start: number; score: number }[] = []
    outer: for (let start = 0; start + block.length <= S; start++) {
      for (let t = start; t < start + block.length; t++) {
        if (use[t]! >= event.capacity || busy[t]! === 1) continue outer
      }
      // Idle heuristic: prefer starts adjacent to the group's existing
      // blocks; a group with nothing placed prefers packing early.
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
    const stuckName = stuck ? `${stuck.group.name}'s ${eventName(input.events, stuck.eventId)}` : 'the schedule'
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
        groupId: block.group.id,
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
    (a, b) => a.slotIndex - b.slotIndex || a.eventId - b.eventId || a.groupId - b.groupId,
  )
  return { ok: true, assignments, seed: input.seed }
}

/** Priority order, seeded shuffle within equal priority. */
function prioritized(groups: SolverGroup[], rand: () => number): SolverGroup[] {
  return shuffled(groups, rand).sort((a, b) => b.priority - a.priority)
}

function eventName(events: SolverEvent[], id: number): string {
  return events.find((e) => e.id === id)?.name ?? `event #${id}`
}

/**
 * Soft constraint: coaches stay with their group (group mode) or own an
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

  const groupById = new Map(input.groups.map((g) => [g.id, g]))
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

  if (input.coachMode === 'group') {
    for (const a of generated) {
      const prefs = groupById.get(a.groupId)?.assignedCoaches ?? []
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
  const requiredSlots = new Map<string, number>() // `${groupId}:${eventId}` → slots
  for (const group of input.groups) {
    let totalSlots = 0
    for (const req of group.requiredEvents) {
      const event = eventById.get(req.eventId)
      if (!event) {
        reasons.push(`${group.name} requires an event that no longer exists.`)
        continue
      }
      if (!event.active) {
        reasons.push(`${group.name} requires ${event.name}, which is marked inactive.`)
        continue
      }
      if (req.duration <= 0 || req.duration % rot !== 0) {
        reasons.push(
          `${group.name}'s ${req.duration} min on ${event.name} isn't a multiple of the ${rot}-min rotation.`,
        )
        continue
      }
      const slots = req.duration / rot
      if (slots > S) {
        reasons.push(
          `${group.name} needs ${req.duration} min on ${event.name} but the session is only ${minutes(S)} min.`,
        )
      }
      requiredSlots.set(`${group.id}:${req.eventId}`, slots)
      totalSlots += slots
    }
    // Locked cells on events outside the requirements still occupy the group.
    const extraLocked = input.locked.filter(
      (l) =>
        l.groupId === group.id && !group.requiredEvents.some((r) => r.eventId === l.eventId),
    ).length
    if (totalSlots + extraLocked > S) {
      reasons.push(
        `${group.name} needs ${minutes(totalSlots + extraLocked)} min of events but the session is only ${minutes(S)} min.`,
      )
    }
  }

  // Aggregate event demand vs capacity.
  for (const event of input.events) {
    if (!event.active) continue
    let demand = 0
    for (const group of input.groups) {
      demand += requiredSlots.get(`${group.id}:${event.id}`) ?? 0
    }
    demand += input.locked.filter(
      (l) =>
        l.eventId === event.id &&
        !requiredSlots.has(`${l.groupId}:${event.id}`),
    ).length
    if (demand > S * event.capacity) {
      reasons.push(
        `${event.name} is overbooked: groups need ${minutes(demand)} min on it but it only fits ${minutes(S * event.capacity)} min.`,
      )
    }
  }

  // Locks must themselves be legal.
  const lockUse = new Map<string, number>()
  const lockGroupAt = new Map<string, number>()
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
        `${event.name} has more locked groups than its capacity of ${event.capacity} at ${slotLabel(lock.slotIndex)}.`,
      )
    }
    const groupKey = `${lock.groupId}:${lock.slotIndex}`
    const prevEvent = lockGroupAt.get(groupKey)
    if (prevEvent !== undefined && prevEvent !== lock.eventId) {
      const group = input.groups.find((g) => g.id === lock.groupId)
      reasons.push(
        `${group?.name ?? 'A group'} is locked in two places at ${slotLabel(lock.slotIndex)}.`,
      )
    }
    lockGroupAt.set(groupKey, lock.eventId)
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
