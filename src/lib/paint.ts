// Pure grid-editing operations for the schedule. No UI imports — the page
// binds pointer events to these and saves the result.
//
// Every operation returns a new Schedule; nothing mutates. Blocks within a
// placement never overlap, so painting is defined as "carve out the span,
// then insert" — which is exactly what overwriting means.
import type { EventBlock, Placement, Schedule } from '../../shared/types.ts'
import { SLOT_MINUTES, overlaps, snap } from '../../shared/slots.ts'

/** Client-side ids for blocks the user just painted. Server ids are real. */
let nextLocalId = -1
export const localBlockId = () => nextLocalId--

const sortBlocks = (blocks: EventBlock[]) => [...blocks].sort((a, b) => a.startMin - b.startMin)

const mapPlacement = (
  schedule: Schedule,
  placementId: number,
  fn: (p: Placement) => Placement,
): Schedule => ({
  placements: schedule.placements.map((p) => (p.id === placementId ? fn(p) : p)),
})

/**
 * Remove [startMin, endMin) from a placement's blocks, splitting or trimming
 * any block it cuts through. This is the erase primitive, and the first half
 * of painting.
 */
export function clearSpan(
  schedule: Schedule,
  placementId: number,
  startMin: number,
  endMin: number,
): Schedule {
  return mapPlacement(schedule, placementId, (p) => {
    const blocks: EventBlock[] = []
    for (const b of p.blocks) {
      if (!overlaps(b.startMin, b.endMin, startMin, endMin)) {
        blocks.push(b)
        continue
      }
      // Keep whatever sticks out either side; a cut through the middle
      // leaves two blocks, which is right — they are separate spans now.
      if (b.startMin < startMin) blocks.push({ ...b, endMin: startMin })
      if (b.endMin > endMin) blocks.push({ ...b, id: localBlockId(), startMin: endMin })
    }
    return { ...p, blocks: sortBlocks(blocks) }
  })
}

/**
 * Paint `eventId` across [startMin, endMin) in a placement, overwriting
 * whatever was there. The span is clamped to the class's own window, so a
 * drag that runs off the end of a class simply stops there.
 */
export function paintSpan(
  schedule: Schedule,
  placementId: number,
  eventId: number,
  startMin: number,
  endMin: number,
  coachId: number | null = null,
): Schedule {
  const placement = schedule.placements.find((p) => p.id === placementId)
  if (!placement) return schedule
  const from = Math.max(snap(Math.min(startMin, endMin)), placement.startMin)
  const to = Math.min(snap(Math.max(startMin, endMin)), placement.endMin)
  if (to - from < SLOT_MINUTES) return schedule

  const cleared = clearSpan(schedule, placementId, from, to)
  return mapPlacement(cleared, placementId, (p) => ({
    ...p,
    blocks: sortBlocks([
      ...p.blocks,
      { id: localBlockId(), eventId, coachId, startMin: from, endMin: to, locked: false },
    ]),
  }))
}

export function eraseSpan(
  schedule: Schedule,
  placementId: number,
  startMin: number,
  endMin: number,
): Schedule {
  const placement = schedule.placements.find((p) => p.id === placementId)
  if (!placement) return schedule
  const from = Math.max(snap(Math.min(startMin, endMin)), placement.startMin)
  const to = Math.min(snap(Math.max(startMin, endMin)), placement.endMin)
  if (to <= from) return schedule
  return clearSpan(schedule, placementId, from, to)
}

/**
 * Drag a block's edge. The block keeps its other edge; growing eats whatever
 * it grows into, shrinking just frees the time. Never escapes the window,
 * and never shrinks below one row.
 */
export function resizeBlock(
  schedule: Schedule,
  placementId: number,
  blockId: number,
  edge: 'start' | 'end',
  toMin: number,
): Schedule {
  const placement = schedule.placements.find((p) => p.id === placementId)
  const block = placement?.blocks.find((b) => b.id === blockId)
  if (!placement || !block) return schedule

  const snapped = snap(toMin)
  let startMin = block.startMin
  let endMin = block.endMin
  if (edge === 'start') {
    startMin = Math.min(Math.max(snapped, placement.startMin), block.endMin - SLOT_MINUTES)
  } else {
    endMin = Math.max(Math.min(snapped, placement.endMin), block.startMin + SLOT_MINUTES)
  }
  if (startMin === block.startMin && endMin === block.endMin) return schedule

  // Carve the new footprint out of the neighbours, then drop the block in.
  const withoutSelf = mapPlacement(schedule, placementId, (p) => ({
    ...p,
    blocks: p.blocks.filter((b) => b.id !== blockId),
  }))
  const cleared = clearSpan(withoutSelf, placementId, startMin, endMin)
  return mapPlacement(cleared, placementId, (p) => ({
    ...p,
    blocks: sortBlocks([...p.blocks, { ...block, startMin, endMin }]),
  }))
}

export function removeBlock(schedule: Schedule, placementId: number, blockId: number): Schedule {
  return mapPlacement(schedule, placementId, (p) => ({
    ...p,
    blocks: p.blocks.filter((b) => b.id !== blockId),
  }))
}

export function setBlockCoach(
  schedule: Schedule,
  placementId: number,
  blockId: number,
  coachId: number | null,
): Schedule {
  return mapPlacement(schedule, placementId, (p) => ({
    ...p,
    blocks: p.blocks.map((b) => (b.id === blockId ? { ...b, coachId } : b)),
  }))
}

export function toggleBlockLock(
  schedule: Schedule,
  placementId: number,
  blockId: number,
): Schedule {
  return mapPlacement(schedule, placementId, (p) => ({
    ...p,
    blocks: p.blocks.map((b) => (b.id === blockId ? { ...b, locked: !b.locked } : b)),
  }))
}

/** Is this window free in this column, ignoring `exceptId`? */
export function columnFree(
  schedule: Schedule,
  columnIndex: number,
  startMin: number,
  endMin: number,
  exceptId?: number,
): boolean {
  return !schedule.placements.some(
    (p) =>
      p.columnIndex === columnIndex &&
      p.id !== exceptId &&
      overlaps(p.startMin, p.endMin, startMin, endMin),
  )
}

let nextLocalPlacementId = -1

/** Add a class to a column for a window. Returns null if the lane is busy. */
export function addPlacement(
  schedule: Schedule,
  classId: number,
  columnIndex: number,
  startMin: number,
  endMin: number,
): Schedule | null {
  if (!columnFree(schedule, columnIndex, startMin, endMin)) return null
  return {
    placements: [
      ...schedule.placements,
      {
        id: nextLocalPlacementId--,
        classId,
        columnIndex,
        startMin,
        endMin,
        blocks: [],
      },
    ],
  }
}

export function removePlacement(schedule: Schedule, placementId: number): Schedule {
  return { placements: schedule.placements.filter((p) => p.id !== placementId) }
}

/**
 * Move a placement to another column, keeping its window and its painted
 * work. Refused if the target lane is already busy at that time.
 */
export function movePlacement(
  schedule: Schedule,
  placementId: number,
  toColumn: number,
): Schedule | null {
  const p = schedule.placements.find((x) => x.id === placementId)
  if (!p) return null
  if (!columnFree(schedule, toColumn, p.startMin, p.endMin, placementId)) return null
  return mapPlacement(schedule, placementId, (x) => ({ ...x, columnIndex: toColumn }))
}

/**
 * Change a class's window. Blocks outside the new window are trimmed away —
 * shrinking a class drops the work that no longer fits rather than leaving
 * orphans outside it.
 */
export function resizePlacement(
  schedule: Schedule,
  placementId: number,
  startMin: number,
  endMin: number,
): Schedule | null {
  const p = schedule.placements.find((x) => x.id === placementId)
  if (!p) return null
  const from = snap(startMin)
  const to = snap(endMin)
  if (to - from < SLOT_MINUTES) return null
  if (!columnFree(schedule, p.columnIndex, from, to, placementId)) return null
  return mapPlacement(schedule, placementId, (x) => ({
    ...x,
    startMin: from,
    endMin: to,
    blocks: x.blocks
      .map((b) => ({
        ...b,
        startMin: Math.max(b.startMin, from),
        endMin: Math.min(b.endMin, to),
      }))
      .filter((b) => b.endMin - b.startMin >= SLOT_MINUTES),
  }))
}

/** Swap two columns, carrying every placement in them. */
export function swapColumns(schedule: Schedule, a: number, b: number): Schedule {
  return {
    placements: schedule.placements.map((p) =>
      p.columnIndex === a
        ? { ...p, columnIndex: b }
        : p.columnIndex === b
          ? { ...p, columnIndex: a }
          : p,
    ),
  }
}

/** Drop a column, shifting the ones after it left. */
export function removeColumn(schedule: Schedule, columnIndex: number): Schedule {
  return {
    placements: schedule.placements
      .filter((p) => p.columnIndex !== columnIndex)
      .map((p) => (p.columnIndex > columnIndex ? { ...p, columnIndex: p.columnIndex - 1 } : p)),
  }
}
