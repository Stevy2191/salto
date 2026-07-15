// Independent hard-constraint checker used by the test suite to audit
// solver output. Deliberately written as a separate, straightforward pass —
// not sharing solver internals — so tests cross-check two implementations.
import { SLOT_MINUTES, overlaps } from '../../shared/slots.ts'
import type { SolverInput, SolverPlacementResult } from './types.ts'

export function hardConstraintViolations(
  input: SolverInput,
  result: SolverPlacementResult[],
): string[] {
  const violations: string[] = []
  const eventById = new Map(input.events.map((e) => [e.id, e]))
  const classById = new Map(input.classes.map((c) => [c.id, c]))
  const placementById = new Map(input.placements.map((p) => [p.id, p]))

  const each = result.flatMap((r) =>
    r.blocks.map((b) => ({ ...b, placementId: r.placementId })),
  )

  // 6. Blocks stay inside their placement's window, and are well-formed.
  for (const b of each) {
    const p = placementById.get(b.placementId)
    if (!p) {
      violations.push(`block on unknown placement ${b.placementId}`)
      continue
    }
    if (b.startMin < p.startMin || b.endMin > p.endMin) {
      violations.push(`block escapes placement ${p.id}'s window`)
    }
    if (b.endMin <= b.startMin) violations.push(`empty block on placement ${p.id}`)
    if (b.startMin % SLOT_MINUTES !== 0 || b.endMin % SLOT_MINUTES !== 0) {
      violations.push(`block off the ${SLOT_MINUTES}-minute axis on placement ${p.id}`)
    }
  }

  // 2. A class is in one place at a time: a placement's blocks never overlap.
  for (const r of result) {
    const ordered = [...r.blocks].sort((a, b) => a.startMin - b.startMin)
    for (let i = 1; i < ordered.length; i++) {
      if (overlaps(ordered[i - 1]!.startMin, ordered[i - 1]!.endMin, ordered[i]!.startMin, ordered[i]!.endMin)) {
        violations.push(`placement ${r.placementId} has overlapping blocks`)
      }
    }
  }

  // 1 & 3: capacity and coaches, swept per slot.
  const slots = new Map<number, { eventId: number; coachId: number | null; placementId: number }[]>()
  for (const b of each) {
    for (let t = b.startMin; t < b.endMin; t += SLOT_MINUTES) {
      slots.set(t, [
        ...(slots.get(t) ?? []),
        { eventId: b.eventId, coachId: b.coachId, placementId: b.placementId },
      ])
    }
  }
  for (const [t, live] of slots) {
    const byEvent = new Map<number, Set<number>>()
    for (const l of live) {
      const set = byEvent.get(l.eventId) ?? new Set<number>()
      set.add(l.placementId)
      byEvent.set(l.eventId, set)
    }
    for (const [eventId, users] of byEvent) {
      const capacity = eventById.get(eventId)?.capacity
      if (capacity !== null && capacity !== undefined && users.size > capacity) {
        violations.push(`event ${eventId} over capacity at ${t}`)
      }
    }
    const byCoach = new Map<number, Set<number>>()
    for (const l of live) {
      if (l.coachId === null) continue
      const set = byCoach.get(l.coachId) ?? new Set<number>()
      set.add(l.eventId)
      byCoach.set(l.coachId, set)
    }
    for (const [coachId, events] of byCoach) {
      if (events.size > 1) violations.push(`coach ${coachId} in two places at ${t}`)
    }
  }

  // 4. Required events fulfilled with their full durations, per placement.
  for (const p of input.placements) {
    const cls = classById.get(p.classId)
    if (!cls) continue
    const blocks = result.find((r) => r.placementId === p.id)?.blocks ?? []
    for (const req of cls.requiredEvents) {
      const got = blocks
        .filter((b) => b.eventId === req.eventId)
        .reduce((sum, b) => sum + (b.endMin - b.startMin), 0)
      if (got < req.duration) {
        violations.push(
          `placement ${p.id} got ${got}/${req.duration} min on event ${req.eventId}`,
        )
      }
    }
  }

  // 5. Inactive or unknown events are never scheduled.
  for (const b of each) {
    const event = eventById.get(b.eventId)
    if (!event || !event.active) {
      violations.push(`block on inactive/unknown event ${b.eventId}`)
    }
  }

  // Locked blocks survive untouched.
  for (const p of input.placements) {
    const blocks = result.find((r) => r.placementId === p.id)?.blocks ?? []
    for (const locked of p.locked) {
      const kept = blocks.some(
        (b) =>
          b.eventId === locked.eventId &&
          b.startMin === locked.startMin &&
          b.endMin === locked.endMin,
      )
      if (!kept) violations.push(`placement ${p.id} lost a locked block`)
    }
  }

  return violations
}
