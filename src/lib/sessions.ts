// Pure session display helpers. Lives outside the pages so components and
// pages can share it without import cycles.
import type { Session } from '../../shared/types.ts'
import { formatDateShort } from '../../shared/dates.ts'

/** What to call a session in headings and lists: its name, else date + time. */
export function sessionLabel(session: Session): string {
  return session.name || `${formatDateShort(session.date)} ${session.startTime}`
}
