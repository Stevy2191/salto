// Geometry for the schedule grid: minutes ⇄ pixels. Kept out of the
// component so the drag math is testable and stays in one place.
import { SLOT_MINUTES, sessionWindow } from '../../../shared/slots.ts'
import type { Session } from '../../../shared/types.ts'

/** Height of one 5-minute row, in px. */
export const ROW_H = 20

export const laneHeight = (session: Pick<Session, 'startTime' | 'endTime'>) => {
  const { startMin, endMin } = sessionWindow(session)
  return (Math.max(endMin - startMin, 0) / SLOT_MINUTES) * ROW_H
}

export const minToY = (session: Pick<Session, 'startTime' | 'endTime'>, min: number) =>
  ((min - sessionWindow(session).startMin) / SLOT_MINUTES) * ROW_H

export const spanHeight = (fromMin: number, toMin: number) =>
  ((toMin - fromMin) / SLOT_MINUTES) * ROW_H

/**
 * The minute at pixel offset `y` within a lane, snapped down to the row that
 * contains it and clamped to the session window.
 */
export function yToMin(
  session: Pick<Session, 'startTime' | 'endTime'>,
  y: number,
  { round = false }: { round?: boolean } = {},
): number {
  const { startMin, endMin } = sessionWindow(session)
  const rows = (round ? Math.round : Math.floor)(y / ROW_H)
  const min = startMin + rows * SLOT_MINUTES
  return Math.min(Math.max(min, startMin), endMin)
}
