// Pure time-axis helpers shared by the server and the frontend grid.
//
// The grid's time axis is fixed 5-minute rows: every window and every event
// block snaps to SLOT_MINUTES. Times are carried around as minutes since
// midnight, which is what the schedule tables store.
import type { Session } from './types.ts'

/** The grid's row height in minutes. Everything snaps to this. */
export const SLOT_MINUTES = 5

/** Parse "HH:MM" into minutes since midnight, or null if malformed. */
export function parseTime(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

export function formatTime(minutesSinceMidnight: number): string {
  const h = Math.floor(minutesSinceMidnight / 60) % 24
  const m = minutesSinceMidnight % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Round to the nearest 5-minute boundary. */
export function snap(minutes: number): number {
  return Math.round(minutes / SLOT_MINUTES) * SLOT_MINUTES
}

export function isSnapped(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes % SLOT_MINUTES === 0
}

type Window = Pick<Session, 'startTime' | 'endTime'>

/** The session's master window as minutes since midnight. */
export function sessionWindow(session: Window): { startMin: number; endMin: number } {
  const startMin = parseTime(session.startTime) ?? 0
  const endMin = parseTime(session.endTime) ?? 0
  return { startMin, endMin }
}

/** Number of 5-minute rows in the session's master window. */
export function rowCount(session: Window): number {
  const { startMin, endMin } = sessionWindow(session)
  if (endMin <= startMin) return 0
  return Math.floor((endMin - startMin) / SLOT_MINUTES)
}

/** Minutes since midnight at the top of row `index`. */
export function rowStartMin(session: Window, index: number): number {
  return sessionWindow(session).startMin + index * SLOT_MINUTES
}

/** Clock label for the top of row `index`, e.g. "16:30". */
export function rowLabel(session: Window, index: number): string {
  return formatTime(rowStartMin(session, index))
}

/** Row index containing `minutes`, relative to the session start. */
export function rowIndexOf(session: Window, minutes: number): number {
  return Math.floor((minutes - sessionWindow(session).startMin) / SLOT_MINUTES)
}

/** Do [aStart, aEnd) and [bStart, bEnd) overlap? Touching is not overlap. */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd
}

/** "16:00–18:30" — a window read back the way a coach would say it. */
export function formatRange(startMin: number, endMin: number): string {
  return `${formatTime(startMin)}–${formatTime(endMin)}`
}
