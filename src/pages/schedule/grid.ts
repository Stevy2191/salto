// Geometry for the schedule grid: minutes ⇄ pixels. Kept out of the
// component so the drag math is testable and stays in one place.
import { SLOT_MINUTES, sessionWindow } from '../../../shared/slots.ts'
import type { Session } from '../../../shared/types.ts'

/**
 * Height of one 5-minute row, in px. Big enough to see and to hit with a
 * finger: a single 5-minute slot has to be a real target, since painting one
 * is a normal thing to do. A 4-hour session is ~48 rows and is meant to
 * scroll — rows are never compressed to fit the viewport.
 */
export const ROW_H = 28

type Window = Pick<Session, 'startTime' | 'endTime'>

export const laneHeight = (session: Window) => {
  const { startMin, endMin } = sessionWindow(session)
  return (Math.max(endMin - startMin, 0) / SLOT_MINUTES) * ROW_H
}

export const minToY = (session: Window, min: number) =>
  ((min - sessionWindow(session).startMin) / SLOT_MINUTES) * ROW_H

export const spanHeight = (fromMin: number, toMin: number) =>
  ((toMin - fromMin) / SLOT_MINUTES) * ROW_H

/**
 * The minute at pixel offset `y` within a lane, snapped down to the row that
 * contains it and clamped to the session window.
 */
export function yToMin(session: Window, y: number, { round = false }: { round?: boolean } = {}) {
  const { startMin, endMin } = sessionWindow(session)
  const rows = (round ? Math.round : Math.floor)(y / ROW_H)
  const min = startMin + rows * SLOT_MINUTES
  return Math.min(Math.max(min, startMin), endMin)
}

/**
 * Gridlines drawn as background gradients rather than DOM: a light rule at
 * every 5-minute row, a stronger one every half hour, and the strongest on
 * the hour — so the eye can find "17:30" without counting rows. The heavier
 * lines are phased to real clock times, not to row 0, because a session can
 * start at 16:20 just as easily as 16:00.
 */
export function laneBackground(session: Window): {
  backgroundImage: string
  backgroundSize: string
  backgroundPosition: string
} {
  const { startMin } = sessionWindow(session)
  // Distance from the lane's top to the first :30 and :00 boundary.
  const toHalf = ((30 - (startMin % 30)) % 30) / SLOT_MINUTES
  const toHour = ((60 - (startMin % 60)) % 60) / SLOT_MINUTES

  const line = (color: string) =>
    `linear-gradient(to bottom, ${color} 0 1px, transparent 1px)`
  return {
    // Painted last-to-first: hour over half-hour over the 5-minute rule.
    backgroundImage: [
      line('var(--grid-hour)'),
      line('var(--grid-half)'),
      line('var(--grid-row)'),
    ].join(','),
    backgroundSize: [`100% ${ROW_H * 12}px`, `100% ${ROW_H * 6}px`, `100% ${ROW_H}px`].join(','),
    backgroundPosition: [`0 ${toHour * ROW_H}px`, `0 ${toHalf * ROW_H}px`, '0 0'].join(','),
  }
}
