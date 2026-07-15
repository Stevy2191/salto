// Minimal-disruption repair for day-of changes (absent coach, event out).
// Pure and seeded like the rest of the solver.
//
// Semantics:
// - Assignments on an event that is out for the session are removed, and
//   requirements on that event are waived for this solve (the event is
//   down for the whole session — there is nowhere to move them).
// - Every other original assignment is treated as locked: repair never
//   moves it. Cells that lose an absent coach keep their slot/event and
//   are restaffed (or left coachless) — never double-booking anyone.
// - Requirements left uncovered are placed by the normal solver around
//   the locks.
import type { Assignment } from '../../shared/types.ts'
import { slotStart } from '../../shared/slots.ts'
import { generateSchedule } from './solver.ts'
import type { SolverClass, SolverCoach, SolverEvent, SolverInput } from './types.ts'

export interface RepairInput extends Omit<SolverInput, 'locked'> {
  /** The schedule as it stands. */
  original: Assignment[]
  absentCoachIds: number[]
  unavailableEventIds: number[]
}

export type RepairChange =
  | { kind: 'removed-event-out'; classId: number; eventId: number; slotIndex: number }
  | {
      kind: 'coach-reassigned'
      classId: number
      eventId: number
      slotIndex: number
      fromCoachId: number
      toCoachId: number | null
    }
  | { kind: 'added'; classId: number; eventId: number; slotIndex: number }

export interface RepairSuccess {
  ok: true
  assignments: Assignment[]
  changes: RepairChange[]
  seed: number
}

export type RepairResult = RepairSuccess | { ok: false; reasons: string[] }

const keyOf = (a: Assignment) => `${a.slotIndex}:${a.eventId}:${a.classId}`

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
  const keeps: Assignment[] = []
  for (const a of input.original) {
    if (down.has(a.eventId)) {
      changes.push({
        kind: 'removed-event-out',
        classId: a.classId,
        eventId: a.eventId,
        slotIndex: a.slotIndex,
      })
      continue
    }
    keeps.push({
      ...a,
      coachId: a.coachId !== null && absent.has(a.coachId) ? null : a.coachId,
      locked: true,
    })
  }

  const solved = generateSchedule({
    events,
    classes,
    coaches,
    slotCount: input.slotCount,
    rotationLength: input.rotationLength,
    coachMode: input.coachMode,
    adjacencyPenalties: input.adjacencyPenalties,
    locked: keeps,
    seed: input.seed,
  })
  if (!solved.ok) return solved

  const assignments = solved.assignments.map((a) => ({ ...a }))
  const originalByKey = new Map(input.original.map((a) => [keyOf(a), a]))
  const classById = new Map(input.classes.map((c) => [c.id, c]))

  // Restaff cells that lost their coach to an absence. coachAt reflects the
  // whole repaired schedule so restaffing never double-books.
  const coachAt = new Map<number, Map<number, number>>(coaches.map((c) => [c.id, new Map()]))
  for (const a of assignments) {
    if (a.coachId !== null) coachAt.get(a.coachId)?.set(a.slotIndex, a.eventId)
  }
  const tryStaff = (a: Assignment, coachId: number): boolean => {
    const at = coachAt.get(coachId)
    if (!at) return false
    const current = at.get(a.slotIndex)
    if (current !== undefined && current !== a.eventId) return false
    at.set(a.slotIndex, a.eventId)
    a.coachId = coachId
    return true
  }
  for (const a of assignments) {
    const before = originalByKey.get(keyOf(a))
    if (!before || before.coachId === null || !absent.has(before.coachId)) continue
    if (a.coachId === null) {
      const prefs =
        input.coachMode === 'class'
          ? (classById.get(a.classId)?.assignedCoaches ?? []).filter((id) => !absent.has(id))
          : []
      const specialists = coaches.filter((c) => c.specialties.includes(a.eventId)).map((c) => c.id)
      for (const coachId of [...prefs, ...specialists]) {
        if (tryStaff(a, coachId)) break
      }
    }
    changes.push({
      kind: 'coach-reassigned',
      classId: a.classId,
      eventId: a.eventId,
      slotIndex: a.slotIndex,
      fromCoachId: before.coachId,
      toCoachId: a.coachId,
    })
  }

  // Anything the solver newly placed (requirements the locks didn't cover).
  for (const a of assignments) {
    if (!originalByKey.has(keyOf(a))) {
      changes.push({ kind: 'added', classId: a.classId, eventId: a.eventId, slotIndex: a.slotIndex })
    }
  }

  // Repair borrowed the lock mechanism to pin unaffected cells; restore the
  // user's real lock flags on the way out.
  for (const a of assignments) {
    a.locked = originalByKey.get(keyOf(a))?.locked ?? false
  }

  return { ok: true, assignments, changes, seed: input.seed }
}

export interface RepairChangeContext {
  events: { id: number; name: string }[]
  classes: { id: number; name: string }[]
  coaches: { id: number; name: string }[]
  /** When given, messages use clock times; otherwise "rotation N". */
  startTime?: string
  rotationLength: number
}

/** Human-readable summary, aggregated per block ("moved…", "reassigned…"). */
export function describeRepairChanges(
  changes: RepairChange[],
  ctx: RepairChangeContext,
): string[] {
  const name = (list: { id: number; name: string }[], id: number, fallback: string) =>
    list.find((x) => x.id === id)?.name ?? fallback
  const time = (slot: number) =>
    ctx.startTime
      ? slotStart({ startTime: ctx.startTime, rotationLength: ctx.rotationLength }, slot)
      : `rotation ${slot + 1}`

  const messages: string[] = []

  // Removals, one message per (class, event) block set.
  const removed = new Map<string, number[]>()
  for (const c of changes) {
    if (c.kind !== 'removed-event-out') continue
    const key = `${c.classId}:${c.eventId}`
    removed.set(key, [...(removed.get(key) ?? []), c.slotIndex])
  }
  for (const [key, slots] of removed) {
    const [classId, eventId] = key.split(':').map(Number)
    messages.push(
      `${name(ctx.events, eventId!, 'An event')} is out: removed ${name(ctx.classes, classId!, 'a class')}'s ${time(Math.min(...slots))} block (requirement skipped this session).`,
    )
  }

  // Coach reassignments, aggregated per (class, event, from, to).
  const reassigned = new Map<
    string,
    { classId: number; eventId: number; from: number; to: number | null; slots: number[] }
  >()
  for (const c of changes) {
    if (c.kind !== 'coach-reassigned') continue
    const key = `${c.classId}:${c.eventId}:${c.fromCoachId}:${c.toCoachId ?? 'none'}`
    const entry = reassigned.get(key)
    if (entry) entry.slots.push(c.slotIndex)
    else
      reassigned.set(key, {
        classId: c.classId,
        eventId: c.eventId,
        from: c.fromCoachId,
        to: c.toCoachId,
        slots: [c.slotIndex],
      })
  }
  for (const entry of reassigned.values()) {
    const where = `${name(ctx.classes, entry.classId, 'a class')}'s ${time(Math.min(...entry.slots))} ${name(ctx.events, entry.eventId, 'event')}`
    messages.push(
      entry.to === null
        ? `${name(ctx.coaches, entry.from, 'A coach')} is out: ${where} currently has no coach.`
        : `${name(ctx.coaches, entry.from, 'A coach')} is out: ${where} is now coached by ${name(ctx.coaches, entry.to, 'another coach')}.`,
    )
  }

  // Newly placed blocks.
  const added = new Map<string, number[]>()
  for (const c of changes) {
    if (c.kind !== 'added') continue
    const key = `${c.classId}:${c.eventId}`
    added.set(key, [...(added.get(key) ?? []), c.slotIndex])
  }
  for (const [key, slots] of added) {
    const [classId, eventId] = key.split(':').map(Number)
    messages.push(
      `Placed ${name(ctx.classes, classId!, 'a class')}'s ${name(ctx.events, eventId!, 'event')} at ${time(Math.min(...slots))}.`,
    )
  }

  if (messages.length === 0) messages.push('Nothing needed to change.')
  return messages
}
