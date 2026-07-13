// Pure conflict detection for the manual schedule editor. No UI imports —
// the same rules become solver hard constraints in Phase 2.
import type { Assignment, GymEvent } from '../../shared/types.ts'

export type ConflictReason =
  | 'group-double-booked'
  | 'coach-double-booked'
  | 'over-capacity'
  | 'event-inactive'

export const CONFLICT_LABELS: Record<ConflictReason, string> = {
  'group-double-booked': 'group is in two places at once',
  'coach-double-booked': 'coach is in two places at once',
  'over-capacity': 'too many groups on this event',
  'event-inactive': 'event is inactive',
}

/** Identity of one schedule cell entry, used as the conflict-map key. */
export function assignmentKey(a: Pick<Assignment, 'slotIndex' | 'eventId' | 'groupId'>): string {
  return `${a.slotIndex}:${a.eventId}:${a.groupId}`
}

/**
 * Map from assignmentKey to the reasons that assignment is in conflict.
 * Assignments not in the map are conflict-free.
 */
export function findConflicts(
  assignments: Assignment[],
  events: GymEvent[],
): Map<string, ConflictReason[]> {
  const reasons = new Map<string, Set<ConflictReason>>()
  const add = (a: Assignment, reason: ConflictReason) => {
    const key = assignmentKey(a)
    let set = reasons.get(key)
    if (!set) {
      set = new Set()
      reasons.set(key, set)
    }
    set.add(reason)
  }

  // A group must be in exactly one place per slot.
  const byGroupSlot = new Map<string, Assignment[]>()
  // A coach must be in exactly one place per slot.
  const byCoachSlot = new Map<string, Assignment[]>()
  // An event's simultaneous groups must not exceed its capacity.
  const byEventSlot = new Map<string, Assignment[]>()

  for (const a of assignments) {
    const push = (map: Map<string, Assignment[]>, key: string) => {
      const list = map.get(key)
      if (list) list.push(a)
      else map.set(key, [a])
    }
    push(byGroupSlot, `${a.slotIndex}:${a.groupId}`)
    if (a.coachId !== null) push(byCoachSlot, `${a.slotIndex}:${a.coachId}`)
    push(byEventSlot, `${a.slotIndex}:${a.eventId}`)
  }

  for (const list of byGroupSlot.values()) {
    const distinctEvents = new Set(list.map((a) => a.eventId))
    if (distinctEvents.size > 1) {
      for (const a of list) add(a, 'group-double-booked')
    }
  }

  for (const list of byCoachSlot.values()) {
    // Two groups with the same coach at the same event is one station —
    // physically one place, so it is allowed.
    const distinctEvents = new Set(list.map((a) => a.eventId))
    if (distinctEvents.size > 1) {
      for (const a of list) add(a, 'coach-double-booked')
    }
  }

  const eventById = new Map(events.map((e) => [e.id, e]))
  for (const list of byEventSlot.values()) {
    const event = eventById.get(list[0]!.eventId)
    const capacity = event?.capacity ?? 1
    const distinctGroups = new Set(list.map((a) => a.groupId))
    if (distinctGroups.size > capacity) {
      for (const a of list) add(a, 'over-capacity')
    }
  }

  for (const a of assignments) {
    const event = eventById.get(a.eventId)
    if (!event || !event.active) add(a, 'event-inactive')
  }

  return new Map([...reasons].map(([key, set]) => [key, [...set]]))
}
