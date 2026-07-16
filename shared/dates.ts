// Pure calendar-date helpers shared by the server and the frontend.
//
// Classes carry weekday schedules (0 = Sunday … 6 = Saturday), and sessions
// are auto-derived weekly slots labelled by day + start time. The remaining
// "YYYY-MM-DD" helpers exist for the migration off the old dated-session
// model and anywhere a real calendar day is still handled.

export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

/** Parse "YYYY-MM-DD" into a UTC Date, or null if malformed or not a real day. */
export function parseIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const [, y, m, d] = match
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  // Reject overflow like 2026-02-31, which Date silently rolls forward.
  if (
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(m) - 1 ||
    date.getUTCDate() !== Number(d)
  ) {
    return null
  }
  return date
}

export function isIsoDate(value: string): boolean {
  return parseIsoDate(value) !== null
}

/** Day of week for an ISO date: 0 = Sunday … 6 = Saturday. */
export function dayOfWeekOf(isoDate: string): number {
  return parseIsoDate(isoDate)?.getUTCDay() ?? 0
}

/** "17:00" → "5:00 PM". Passes anything unparseable straight through. */
export function formatTime12(hhmm: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm)
  if (!match) return hhmm
  let hour = Number(match[1])
  const ampm = hour < 12 ? 'AM' : 'PM'
  hour %= 12
  if (hour === 0) hour = 12
  return `${hour}:${match[2]} ${ampm}`
}

/** "Monday 5:00 PM" — the display label for an auto-derived session slot. */
export function slotLabel(dayOfWeek: number, startTime: string): string {
  return `${DAY_NAMES[dayOfWeek] ?? 'Day'} ${formatTime12(startTime)}`
}

export function toIsoDate(date: Date): string {
  const y = String(date.getUTCFullYear()).padStart(4, '0')
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** "YYYY-MM-DD" for today in the machine's local timezone. */
export function todayIsoDate(now = new Date()): string {
  return toIsoDate(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())))
}

export function addDays(isoDate: string, days: number): string {
  const date = parseIsoDate(isoDate)
  if (!date) return isoDate
  date.setUTCDate(date.getUTCDate() + days)
  return toIsoDate(date)
}

/** "2026-03-03" → "Tuesday, March 3, 2026". */
export function formatDateLong(isoDate: string): string {
  const date = parseIsoDate(isoDate)
  if (!date) return isoDate
  return `${DAY_NAMES[date.getUTCDay()]}, ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`
}

/** "2026-03-03" → "Tue Mar 3" — compact, for lists and default labels. */
export function formatDateShort(isoDate: string): string {
  const date = parseIsoDate(isoDate)
  if (!date) return isoDate
  return `${DAY_NAMES[date.getUTCDay()]!.slice(0, 3)} ${MONTH_NAMES[date.getUTCMonth()]!.slice(0, 3)} ${date.getUTCDate()}`
}
