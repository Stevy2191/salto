// Pure session display helpers. Lives outside the pages so components and
// pages can share it without import cycles.
import type { Session } from '../../shared/types.ts'
import { slotLabel } from '../../shared/dates.ts'

/** What to call a session slot in headings and lists, e.g. "Monday 5:00 PM". */
export function sessionLabel(session: Session): string {
  return session.name || slotLabel(session.dayOfWeek, session.startTime)
}
