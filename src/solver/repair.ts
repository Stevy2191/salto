// Minimal-disruption repair for day-of changes (absent coach, event out).
// Pure and seeded like the rest of the solver.
//
// Semantics:
// - Blocks on an event that is out for the session are removed, and
//   requirements on that event are waived for this solve (the event is
//   down for the whole session — there is nowhere to move them).
// - Every other block is treated as locked: repair never moves it. Blocks
//   that lose an absent coach keep their time and event and are restaffed
//   (or left coachless) — never double-booking anyone.
// - Requirements left uncovered are placed by the normal solver around
//   the locks, inside each class's own window.
import { formatTime } from '../../shared/slots.ts'
import { generateSchedule } from './solver.ts'
import type {
  SolverBlock,
  SolverClass,
  SolverCoach,
  SolverEvent,
  SolverInput,
  SolverPlacementResult,
} from './types.ts'

export interface RepairInput extends Omit<SolverInput, 'placements'> {
  /** The grid as it stands: every block, locked or not. */
  placements: {
    id: number
    classId: number
    startMin: number
    endMin: number
    blocks: (SolverBlock & { locked: boolean })[]
  }[]
  absentCoachIds: number[]
  unavailableEventIds: number[]
}

export type RepairChange =
  | { kind: 'removed-event-out'; placementId: number; classId: number; eventId: number; startMin: number }
  | {
      kind: 'coach-reassigned'
      placementId: number
      classId: number
      eventId: number
      startMin: number
      fromCoachId: number
      toCoachId: number | null
    }
  | { kind: 'added'; placementId: number; classId: number; eventId: number; startMin: number }

export interface RepairSuccess {
  ok: true
  placements: SolverPlacementResult[]
  changes: RepairChange[]
  seed: number
}

export type RepairResult = RepairSuccess | { ok: false; reasons: string[] }

const keyOf = (placementId: number, b: { eventId: number; startMin: number }) =>
  `${placementId}:${b.eventId}:${b.startMin}`

export function repairSchedule(input: RepairInput): RepairResult {
  const down = new Set(input.unavailableEventIds)
  const absent = new Set(input.absentCoachIds)

  // Effective world for this session: out events are inactive, absent
  // coaches don't exist, and requirements on out events are waived.
  const events: SolverEvent[] = input.events.map((e) =>
    down.has(e.id) ? { ...e, active: false } : e,
  )
  const coaches: SolverCoach[] = input.coaches.filter((c) => !absent.has(c.id))
  const classes: SolverClass[] = input.classes.map((c) => ({
    ...c,
    requiredEvents: c.requiredEvents.filter((r) => !down.has(r.eventId)),
    assignedCoaches: c.assignedCoaches.filter((id) => !absent.has(id)),
  }))

  const changes: RepairChange[] = []
  const originalByKey = new Map<string, SolverBlock & { locked: boolean }>()
  const solverPlacements = input.placements.map((p) => {
    const keeps: SolverBlock[] = []
    for (const b of p.blocks) {
      originalByKey.set(keyOf(p.id, b), b)
      if (down.has(b.eventId)) {
        changes.push({
          kind: 'removed-event-out',
          placementId: p.id,
          classId: p.classId,
          eventId: b.eventId,
          startMin: b.startMin,
        })
        continue
      }
      keeps.push({
        eventId: b.eventId,
        startMin: b.startMin,
        endMin: b.endMin,
        coachId: b.coachId !== null && absent.has(b.coachId) ? null : b.coachId,
      })
    }
    return {
      id: p.id,
      classId: p.classId,
      startMin: p.startMin,
      endMin: p.endMin,
      locked: keeps,
    }
  })

  const solved = generateSchedule({
    events,
    classes,
    coaches,
    placements: solverPlacements,
    coachMode: input.coachMode,
    adjacencyPenalties: input.adjacencyPenalties,
    seed: input.seed,
  })
  if (!solved.ok) return solved

  const placements = solved.placements.map((r) => ({
    placementId: r.placementId,
    blocks: r.blocks.map((b) => ({ ...b })),
  }))
  const classOf = new Map(input.placements.map((p) => [p.id, p.classId]))
  const classById = new Map(input.classes.map((c) => [c.id, c]))

  // Restaff blocks that lost their coach to an absence. coachAt reflects the
  // whole repaired grid so restaffing never double-books.
  const coachAt = new Map<number, Map<number, number>>(coaches.map((c) => [c.id, new Map()]))
  for (const r of placements) {
    for (const b of r.blocks) {
      if (b.coachId === null) continue
      for (let t = b.startMin; t < b.endMin; t += 5) coachAt.get(b.coachId)?.set(t, b.eventId)
    }
  }
  const tryStaff = (b: SolverBlock, coachId: number): boolean => {
    const at = coachAt.get(coachId)
    if (!at) return false
    for (let t = b.startMin; t < b.endMin; t += 5) {
      const current = at.get(t)
      if (current !== undefined && current !== b.eventId) return false
    }
    for (let t = b.startMin; t < b.endMin; t += 5) at.set(t, b.eventId)
    b.coachId = coachId
    return true
  }

  for (const r of placements) {
    const classId = classOf.get(r.placementId)!
    for (const b of r.blocks) {
      const before = originalByKey.get(keyOf(r.placementId, b))
      if (!before || before.coachId === null || !absent.has(before.coachId)) continue
      if (b.coachId === null) {
        const prefs =
          input.coachMode === 'class'
            ? (classById.get(classId)?.assignedCoaches ?? []).filter((id) => !absent.has(id))
            : []
        const specialists = coaches.filter((c) => c.specialties.includes(b.eventId)).map((c) => c.id)
        for (const coachId of [...prefs, ...specialists]) {
          if (tryStaff(b, coachId)) break
        }
      }
      changes.push({
        kind: 'coach-reassigned',
        placementId: r.placementId,
        classId,
        eventId: b.eventId,
        startMin: b.startMin,
        fromCoachId: before.coachId,
        toCoachId: b.coachId,
      })
    }
    // Anything the solver newly placed (requirements the locks didn't cover).
    for (const b of r.blocks) {
      if (!originalByKey.has(keyOf(r.placementId, b))) {
        changes.push({
          kind: 'added',
          placementId: r.placementId,
          classId,
          eventId: b.eventId,
          startMin: b.startMin,
        })
      }
    }
  }

  return { ok: true, placements, changes, seed: input.seed }
}

export interface RepairChangeContext {
  events: { id: number; name: string }[]
  classes: { id: number; name: string }[]
  coaches: { id: number; name: string }[]
}

/** Human-readable summary, aggregated per block set. */
export function describeRepairChanges(
  changes: RepairChange[],
  ctx: RepairChangeContext,
): string[] {
  const name = (list: { id: number; name: string }[], id: number, fallback: string) =>
    list.find((x) => x.id === id)?.name ?? fallback

  const messages: string[] = []

  const removed = new Map<string, number[]>()
  for (const c of changes) {
    if (c.kind !== 'removed-event-out') continue
    const key = `${c.classId}:${c.eventId}`
    removed.set(key, [...(removed.get(key) ?? []), c.startMin])
  }
  for (const [key, starts] of removed) {
    const [classId, eventId] = key.split(':').map(Number)
    messages.push(
      `${name(ctx.events, eventId!, 'An event')} is out: removed ${name(ctx.classes, classId!, 'a class')}'s ${formatTime(Math.min(...starts))} block (requirement skipped this session).`,
    )
  }

  const reassigned = new Map<
    string,
    { classId: number; eventId: number; from: number; to: number | null; starts: number[] }
  >()
  for (const c of changes) {
    if (c.kind !== 'coach-reassigned') continue
    const key = `${c.classId}:${c.eventId}:${c.fromCoachId}:${c.toCoachId ?? 'none'}`
    const entry = reassigned.get(key)
    if (entry) entry.starts.push(c.startMin)
    else
      reassigned.set(key, {
        classId: c.classId,
        eventId: c.eventId,
        from: c.fromCoachId,
        to: c.toCoachId,
        starts: [c.startMin],
      })
  }
  for (const entry of reassigned.values()) {
    const where = `${name(ctx.classes, entry.classId, 'a class')}'s ${formatTime(Math.min(...entry.starts))} ${name(ctx.events, entry.eventId, 'event')}`
    messages.push(
      entry.to === null
        ? `${name(ctx.coaches, entry.from, 'A coach')} is out: ${where} currently has no coach.`
        : `${name(ctx.coaches, entry.from, 'A coach')} is out: ${where} is now coached by ${name(ctx.coaches, entry.to, 'another coach')}.`,
    )
  }

  const added = new Map<string, number[]>()
  for (const c of changes) {
    if (c.kind !== 'added') continue
    const key = `${c.classId}:${c.eventId}`
    added.set(key, [...(added.get(key) ?? []), c.startMin])
  }
  for (const [key, starts] of added) {
    const [classId, eventId] = key.split(':').map(Number)
    messages.push(
      `Placed ${name(ctx.classes, classId!, 'a class')}'s ${name(ctx.events, eventId!, 'event')} at ${formatTime(Math.min(...starts))}.`,
    )
  }

  if (messages.length === 0) messages.push('Nothing needed to change.')
  return messages
}

