// Pure block computation for a class's timeline: consecutive slots on the
// same event with the same coach form one block. Used by the print view
// and the per-class strips. No UI imports.
import type { Assignment } from '../../shared/types.ts'

export interface ScheduleBlock {
  startSlot: number
  length: number
  eventId: number
  coachId: number | null
}

export function classBlocks(
  assignments: Assignment[],
  classId: number,
  slotCount: number,
): ScheduleBlock[] {
  const bySlot = new Map<number, Assignment>()
  for (const a of assignments) {
    if (a.classId === classId) bySlot.set(a.slotIndex, a)
  }
  const blocks: ScheduleBlock[] = []
  let current: ScheduleBlock | null = null
  for (let slot = 0; slot < slotCount; slot++) {
    const a = bySlot.get(slot)
    if (!a) {
      current = null
      continue
    }
    if (current && current.eventId === a.eventId && current.coachId === a.coachId) {
      current.length++
      continue
    }
    current = { startSlot: slot, length: 1, eventId: a.eventId, coachId: a.coachId }
    blocks.push(current)
  }
  return blocks
}
