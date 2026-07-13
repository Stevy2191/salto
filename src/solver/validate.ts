// Independent hard-constraint checker used by the test suite to audit
// solver output. Deliberately written as a separate, straightforward pass —
// not sharing solver internals — so tests cross-check two implementations.
import type { Assignment } from '../../shared/types.ts'
import type { SolverInput } from './types.ts'

export function hardConstraintViolations(
  input: SolverInput,
  assignments: Assignment[],
): string[] {
  const violations: string[] = []
  const eventById = new Map(input.events.map((e) => [e.id, e]))

  // 1. Capacity per (event, slot).
  const use = new Map<string, number>()
  for (const a of assignments) {
    const key = `${a.eventId}:${a.slotIndex}`
    use.set(key, (use.get(key) ?? 0) + 1)
  }
  for (const [key, count] of use) {
    const eventId = Number(key.split(':')[0])
    const capacity = eventById.get(eventId)?.capacity ?? 1
    if (count > capacity) violations.push(`event ${eventId} over capacity: ${key}`)
  }

  // 2. Group in one place per slot.
  const groupAt = new Map<string, number>()
  for (const a of assignments) {
    const key = `${a.groupId}:${a.slotIndex}`
    const prev = groupAt.get(key)
    if (prev !== undefined && prev !== a.eventId) {
      violations.push(`group ${a.groupId} in two places at slot ${a.slotIndex}`)
    }
    groupAt.set(key, a.eventId)
  }

  // 3. Coach in one place per slot.
  const coachAt = new Map<string, number>()
  for (const a of assignments) {
    if (a.coachId === null) continue
    const key = `${a.coachId}:${a.slotIndex}`
    const prev = coachAt.get(key)
    if (prev !== undefined && prev !== a.eventId) {
      violations.push(`coach ${a.coachId} in two places at slot ${a.slotIndex}`)
    }
    coachAt.set(key, a.eventId)
  }

  // 4. Required events fulfilled with full durations.
  for (const group of input.groups) {
    for (const req of group.requiredEvents) {
      const needed = req.duration / input.rotationLength
      const got = assignments.filter(
        (a) => a.groupId === group.id && a.eventId === req.eventId,
      ).length
      if (got < needed) {
        violations.push(
          `group ${group.id} got ${got}/${needed} slots on event ${req.eventId}`,
        )
      }
    }
  }

  // 5. Inactive events never scheduled; slots inside the window.
  for (const a of assignments) {
    const event = eventById.get(a.eventId)
    if (!event || !event.active) {
      violations.push(`assignment on inactive/unknown event ${a.eventId}`)
    }
    if (a.slotIndex < 0 || a.slotIndex >= input.slotCount) {
      violations.push(`assignment outside the session window at slot ${a.slotIndex}`)
    }
  }

  return violations
}
