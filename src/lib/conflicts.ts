// Pure conflict detection for the schedule grid. No UI imports — the same
// rules are the solver's hard constraints.
//
// The lane model makes one old conflict structural: a class can't be in two
// places at once *within* a placement, because its blocks can't overlap. But
// the same class can be placed twice at overlapping times in different
// columns, so that check lives on here.
import type { GymEvent, Placement, Schedule } from '../../shared/types.ts'
import { SLOT_MINUTES, overlaps } from '../../shared/slots.ts'

export type BlockConflict = 'coach-double-booked' | 'over-capacity' | 'event-inactive'
export type PlacementConflict = 'column-overlap' | 'class-double-booked'

export const BLOCK_CONFLICT_LABELS: Record<BlockConflict, string> = {
  'coach-double-booked': 'coach is in two places at once',
  'over-capacity': 'too many classes on this event',
  'event-inactive': 'event is inactive',
}

export const PLACEMENT_CONFLICT_LABELS: Record<PlacementConflict, string> = {
  'column-overlap': 'two classes overlap in this column',
  'class-double-booked': 'this class is in two columns at once',
}

export interface Conflicts {
  /** Block id → why it conflicts. */
  blocks: Map<number, BlockConflict[]>
  /** Placement id → why it conflicts. */
  placements: Map<number, PlacementConflict[]>
  count: number
}

function add<K, V>(map: Map<K, Set<V>>, key: K, value: V) {
  const set = map.get(key)
  if (set) set.add(value)
  else map.set(key, new Set([value]))
}

const freeze = <K, V>(map: Map<K, Set<V>>): Map<K, V[]> =>
  new Map([...map].map(([k, set]) => [k, [...set]]))

export function findConflicts(schedule: Schedule, events: GymEvent[]): Conflicts {
  const blockReasons = new Map<number, Set<BlockConflict>>()
  const placementReasons = new Map<number, Set<PlacementConflict>>()
  const eventById = new Map(events.map((e) => [e.id, e]))

  // --- Placement-level: the lane rule, and a class cloned across lanes. ---
  const byColumn = new Map<number, Placement[]>()
  for (const p of schedule.placements) {
    byColumn.set(p.columnIndex, [...(byColumn.get(p.columnIndex) ?? []), p])
  }
  for (const lane of byColumn.values()) {
    for (let i = 0; i < lane.length; i++) {
      for (let j = i + 1; j < lane.length; j++) {
        const a = lane[i]!
        const b = lane[j]!
        if (overlaps(a.startMin, a.endMin, b.startMin, b.endMin)) {
          add(placementReasons, a.id, 'column-overlap')
          add(placementReasons, b.id, 'column-overlap')
        }
      }
    }
  }
  for (let i = 0; i < schedule.placements.length; i++) {
    for (let j = i + 1; j < schedule.placements.length; j++) {
      const a = schedule.placements[i]!
      const b = schedule.placements[j]!
      if (a.classId !== b.classId || a.columnIndex === b.columnIndex) continue
      if (overlaps(a.startMin, a.endMin, b.startMin, b.endMin)) {
        add(placementReasons, a.id, 'class-double-booked')
        add(placementReasons, b.id, 'class-double-booked')
      }
    }
  }

  // --- Block-level: swept per 5-minute slot so this stays linear in the
  // number of painted minutes rather than quadratic in blocks. ---
  interface Live {
    blockId: number
    eventId: number
    coachId: number | null
    classId: number
  }
  const bySlot = new Map<number, Live[]>()
  for (const p of schedule.placements) {
    for (const b of p.blocks) {
      const event = eventById.get(b.eventId)
      if (!event || !event.active) add(blockReasons, b.id, 'event-inactive')
      for (let t = b.startMin; t < b.endMin; t += SLOT_MINUTES) {
        const live: Live = {
          blockId: b.id,
          eventId: b.eventId,
          coachId: b.coachId,
          classId: p.classId,
        }
        bySlot.set(t, [...(bySlot.get(t) ?? []), live])
      }
    }
  }

  for (const live of bySlot.values()) {
    // A coach in two different places in the same slot. Two classes with the
    // same coach at the same event is one station — physically one place.
    const byCoach = new Map<number, Live[]>()
    for (const l of live) {
      if (l.coachId === null) continue
      byCoach.set(l.coachId, [...(byCoach.get(l.coachId) ?? []), l])
    }
    for (const list of byCoach.values()) {
      if (new Set(list.map((l) => l.eventId)).size > 1) {
        for (const l of list) add(blockReasons, l.blockId, 'coach-double-booked')
      }
    }

    // More simultaneous classes on an event than it fits.
    const byEvent = new Map<number, Live[]>()
    for (const l of live) byEvent.set(l.eventId, [...(byEvent.get(l.eventId) ?? []), l])
    for (const [eventId, list] of byEvent) {
      const capacity = eventById.get(eventId)?.capacity
      if (capacity === null || capacity === undefined) continue // no limit
      if (new Set(list.map((l) => l.classId)).size > capacity) {
        for (const l of list) add(blockReasons, l.blockId, 'over-capacity')
      }
    }
  }

  return {
    blocks: freeze(blockReasons),
    placements: freeze(placementReasons),
    count: blockReasons.size + placementReasons.size,
  }
}
