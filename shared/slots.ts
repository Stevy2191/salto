// Pure time-slot helpers shared by the server and the frontend grid.
import type { Session } from './types.ts'

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

/** Number of whole rotation slots that fit in the session window. */
export function slotCount(session: Pick<Session, 'startTime' | 'endTime' | 'rotationLength'>): number {
  const start = parseTime(session.startTime)
  const end = parseTime(session.endTime)
  if (start === null || end === null || end <= start || session.rotationLength <= 0) {
    return 0
  }
  return Math.floor((end - start) / session.rotationLength)
}

/** Start time of a slot, e.g. slotStart(session, 2) → "16:30". */
export function slotStart(
  session: Pick<Session, 'startTime' | 'rotationLength'>,
  slotIndex: number,
): string {
  const start = parseTime(session.startTime) ?? 0
  return formatTime(start + slotIndex * session.rotationLength)
}
