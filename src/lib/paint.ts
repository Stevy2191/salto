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
 * The room a block has to grow into: the gap between its nearest neighbours,
 * bounded by the class's own window. Resizing clamps to this rather than
 * eating a sibling — growing over the block next door would destroy work the
 * user did not point at.
 */
export function blockBounds(
  schedule: Schedule,
  placementId: number,
  blockId: number,
): { min: number; max: number } | null {
  const placement = schedule.placements.find((p) => p.id === placementId)
  const block = placement?.blocks.find((b) => b.id === blockId)
  if (!placement || !block) return null
  const siblings = placement.blocks.filter((b) => b.id !== blockId)
  const min = siblings
    .filter((b) => b.endMin <= block.startMin)
    .reduce((lo, b) => Math.max(lo, b.endMin), placement.startMin)
  const max = siblings
    .filter((b) => b.startMin >= block.endMin)
    .reduce((hi, b) => Math.min(hi, b.startMin), placement.endMin)
  return { min, max }
}

/**
 * Drag a block's edge. The block keeps its other edge and clamps to the gap
 * it lives in, so it can never shrink below one row, escape the class's
 * window, or overwrite a neighbour.
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
  const bounds = blockBounds(schedule, placementId, blockId)
  if (!placement || !block || !bounds) return schedule

  const snapped = snap(toMin)
  const startMin =
    edge === 'start'
      ? Math.min(Math.max(snapped, bounds.min), block.endMin - SLOT_MINUTES)
      : block.startMin
  const endMin =
    edge === 'end'
      ? Math.max(Math.min(snapped, bounds.max), block.startMin + SLOT_MINUTES)
      : block.endMin
  if (startMin === block.startMin && endMin === block.endMin) return schedule

  return mapPlacement(schedule, placementId, (p) => ({
    ...p,
    blocks: sortBlocks(p.blocks.map((b) => (b.id === blockId ? { ...b, startMin, endMin } : b))),
  }))
}

/** Where a block would land if moved, clamped to the target class's window. */
export function moveTarget(
  schedule: Schedule,
  fromPlacementId: number,
  blockId: number,
  toPlacementId: number,
  newStartMin: number,
): { startMin: number; endMin: number; fits: boolean } | null {
  const from = schedule.placements.find((p) => p.id === fromPlacementId)
  const to = schedule.placements.find((p) => p.id === toPlacementId)
  const block = from?.blocks.find((b) => b.id === blockId)
  if (!from || !to || !block) return null

  const duration = block.endMin - block.startMin
  if (duration > to.endMin - to.startMin) return null // cannot fit at all
  const startMin = Math.min(Math.max(snap(newStartMin), to.startMin), to.endMin - duration)
  const endMin = startMin + duration
  const fits = !to.blocks.some(
    (b) => b.id !== blockId && overlaps(b.startMin, b.endMin, startMin, endMin),
  )
  return { startMin, endMin, fits }
}

/**
 * Move a whole block to a new time, and optionally another class, keeping its
 * duration. Refused (null) when the landing spot is taken — a move that ate
 * the block it landed on would silently destroy work.
 */
export function moveBlock(
  schedule: Schedule,
  fromPlacementId: number,
  blockId: number,
  toPlacementId: number,
  newStartMin: number,
): Schedule | null {
  const target = moveTarget(schedule, fromPlacementId, blockId, toPlacementId, newStartMin)
  if (!target || !target.fits) return null
  const block = schedule.placements
    .find((p) => p.id === fromPlacementId)!
    .blocks.find((b) => b.id === blockId)!
  if (
    fromPlacementId === toPlacementId &&
    target.startMin === block.startMin &&
    target.endMin === block.endMin
  ) {
    return null // nothing moved
  }

  const moved = { ...block, startMin: target.startMin, endMin: target.endMin }
  return {
    placements: schedule.placements.map((p) => {
      if (p.id === fromPlacementId && p.id === toPlacementId) {
        return {
          ...p,
          blocks: sortBlocks(p.blocks.map((b) => (b.id === blockId ? moved : b))),
        }
      }
      if (p.id === fromPlacementId) {
        return { ...p, blocks: p.blocks.filter((b) => b.id !== blockId) }
      }
      if (p.id === toPlacementId) {
        return { ...p, blocks: sortBlocks([...p.blocks, moved]) }
      }
      return p
    }),
  }
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
