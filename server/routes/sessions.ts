import { Router } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import type { Session } from '../../shared/types.ts'
import { PLAN_WEEKS } from '../../shared/types.ts'
import { formatTime, parseTime } from '../../shared/slots.ts'
import { slotLabel } from '../../shared/dates.ts'
import { ApiError, asObject, idParam, intArray } from '../validate.ts'
import { withTransaction } from '../tx.ts'

// Sessions are auto-derived weekly slots, never created by hand. A slot is a
// (dayOfWeek, startTime) pair; `reconcileSessions` turns the classes into
// slots and keeps the two in sync. Nothing else writes the sessions or
// placements tables from attendance — editing a class's schedule is the only
// way to change what a slot contains.

interface SessionRow {
  id: number
  name: string
  day_of_week: number
  start_time: string
  end_time: string
  column_count: number
  week_locks: string
  plan_warnings: string
  absent_coaches: string
  unavailable_events: string
  is_sample: number
  class_count: number
}

const SESSION_SELECT = `SELECT s.*, (
  SELECT COUNT(DISTINCT class_id) FROM placements WHERE session_id = s.id
) AS class_count FROM sessions s`

export const toSession = (r: SessionRow): Session => ({
  id: r.id,
  name: r.name,
  dayOfWeek: r.day_of_week,
  startTime: r.start_time,
  endTime: r.end_time,
  columnCount: r.column_count,
  classCount: r.class_count,
  weekLocks: JSON.parse(r.week_locks) as boolean[],
  planWarnings: JSON.parse(r.plan_warnings) as string[],
  absentCoaches: JSON.parse(r.absent_coaches) as number[],
  unavailableEvents: JSON.parse(r.unavailable_events) as number[],
  isSample: r.is_sample === 1,
})

interface ClassScheduleRow {
  id: number
  days_of_week: string
  start_time: string | null
  period_minutes: number
  is_sample: number
}

interface SlotClass {
  id: number
  periodMinutes: number
  isSample: boolean
}

interface Slot {
  day: number
  start: string
  startMin: number
  classes: SlotClass[]
}

/**
 * Rebuild the derived sessions from the classes. Idempotent, and the single
 * writer of session/placement rows from a class's schedule:
 * - a slot exists for every (day, startTime) a scheduled class meets at;
 * - each class in a slot keeps its own column, in every plan week, spanning
 *   its `[startTime, startTime + periodMinutes]` window;
 * - a slot no class backs is deleted (cascading its placements and blocks),
 *   and a class dropped from a slot loses its placements there;
 * - existing columns, painted blocks, locks, and the plan's warnings survive.
 *
 * Must not run inside another transaction — it opens its own.
 */
export function reconcileSessions(db: DatabaseSync): void {
  const classes = db
    .prepare('SELECT id, days_of_week, start_time, period_minutes, is_sample FROM groups')
    .all() as unknown as ClassScheduleRow[]

  const slots = new Map<string, Slot>()
  for (const c of classes) {
    if (!c.start_time) continue
    const startMin = parseTime(c.start_time)
    if (startMin === null) continue
    const days = JSON.parse(c.days_of_week) as number[]
    for (const day of days) {
      if (!Number.isInteger(day) || day < 0 || day > 6) continue
      const key = `${day}|${c.start_time}`
      let slot = slots.get(key)
      if (!slot) {
        slot = { day, start: c.start_time, startMin, classes: [] }
        slots.set(key, slot)
      }
      slot.classes.push({ id: c.id, periodMinutes: c.period_minutes, isSample: c.is_sample === 1 })
    }
  }

  withTransaction(db, () => {
    const existing = db
      .prepare('SELECT id, day_of_week, start_time FROM sessions')
      .all() as { id: number; day_of_week: number; start_time: string }[]
    const idByKey = new Map(existing.map((s) => [`${s.day_of_week}|${s.start_time}`, s.id]))

    // Drop slots no class backs anymore (cascades placements + blocks).
    for (const s of existing) {
      if (!slots.has(`${s.day_of_week}|${s.start_time}`)) {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id)
      }
    }

    const insertSession = db.prepare(
      'INSERT INTO sessions (name, day_of_week, start_time, end_time, column_count, is_sample) VALUES (?, ?, ?, ?, ?, ?)',
    )
    const insertPlacement = db.prepare(
      'INSERT INTO placements (session_id, class_id, column_index, week, start_min, end_min) VALUES (?, ?, ?, ?, ?, ?)',
    )

    for (const [key, slot] of slots) {
      const label = slotLabel(slot.day, slot.start)
      const isSample = slot.classes.every((c) => c.isSample) ? 1 : 0
      const periodEnd = Math.max(...slot.classes.map((c) => slot.startMin + c.periodMinutes))
      let sessionId = idByKey.get(key)
      if (sessionId === undefined) {
        sessionId = Number(
          insertSession.run(label, slot.day, slot.start, formatTime(periodEnd), slot.classes.length, isSample)
            .lastInsertRowid,
        )
      }

      const placed = db
        .prepare('SELECT DISTINCT class_id, column_index FROM placements WHERE session_id = ?')
        .all(sessionId) as { class_id: number; column_index: number }[]
      const wanted = new Set(slot.classes.map((c) => c.id))
      for (const p of placed) {
        if (!wanted.has(p.class_id)) {
          db.prepare('DELETE FROM placements WHERE session_id = ? AND class_id = ?').run(
            sessionId,
            p.class_id,
          )
        }
      }

      const columnOf = new Map(
        placed.filter((p) => wanted.has(p.class_id)).map((p) => [p.class_id, p.column_index]),
      )
      const used = new Set(columnOf.values())
      const haveWeeks = new Map<number, Set<number>>()
      for (const r of db
        .prepare('SELECT class_id, week FROM placements WHERE session_id = ?')
        .all(sessionId) as { class_id: number; week: number }[]) {
        let set = haveWeeks.get(r.class_id)
        if (!set) haveWeeks.set(r.class_id, (set = new Set()))
        set.add(r.week)
      }

      let nextColumn = 0
      const takeColumn = () => {
        while (used.has(nextColumn)) nextColumn++
        used.add(nextColumn)
        return nextColumn
      }
      for (const c of slot.classes) {
        const column = columnOf.get(c.id) ?? takeColumn()
        const have = haveWeeks.get(c.id) ?? new Set<number>()
        for (let week = 1; week <= PLAN_WEEKS; week++) {
          if (!have.has(week)) {
            insertPlacement.run(sessionId, c.id, column, week, slot.startMin, slot.startMin + c.periodMinutes)
          }
        }
      }

      const columnCount = slot.classes.length === 0 ? 0 : Math.max(...used) + 1
      // The axis must cover both the classes' periods and any block a migrated
      // placement still carries beyond them.
      const maxPlacementEnd =
        (db.prepare('SELECT MAX(end_min) AS m FROM placements WHERE session_id = ?').get(sessionId) as {
          m: number | null
        }).m ?? periodEnd
      const endMin = Math.max(periodEnd, maxPlacementEnd)
      db.prepare(
        'UPDATE sessions SET name = ?, end_time = ?, column_count = ?, is_sample = ? WHERE id = ?',
      ).run(label, formatTime(endMin), columnCount, isSample, sessionId)
    }
  })
}

export function sessionRoutes(db: DatabaseSync): Router {
  const router = Router()

  // The read paths reconcile first, so the derived view is always current
  // even if a class changed through a path that didn't reconcile.
  router.get('/sessions', (_req, res) => {
    reconcileSessions(db)
    const rows = db
      .prepare(`${SESSION_SELECT} ORDER BY s.day_of_week, s.start_time`)
      .all() as unknown as SessionRow[]
    res.json({ sessions: rows.map(toSession) })
  })

  router.get('/sessions/:id', (req, res) => {
    reconcileSessions(db)
    const id = idParam(req.params.id)
    const row = db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as unknown as
      | SessionRow
      | undefined
    if (!row) throw new ApiError(404, 'session not found')
    res.json({ session: toSession(row) })
  })

  // Day-of outages, per slot. Kept separate so nothing else clears them.
  router.put('/sessions/:id/outages', (req, res) => {
    const id = idParam(req.params.id)
    if (!db.prepare('SELECT id FROM sessions WHERE id = ?').get(id)) {
      throw new ApiError(404, 'session not found')
    }
    const obj = asObject(req.body)
    const absentCoaches = intArray(obj.absentCoaches, 'absentCoaches')
    const unavailableEvents = intArray(obj.unavailableEvents, 'unavailableEvents')
    db.prepare('UPDATE sessions SET absent_coaches = ?, unavailable_events = ? WHERE id = ?').run(
      JSON.stringify(absentCoaches),
      JSON.stringify(unavailableEvents),
      id,
    )
    const row = db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as unknown as SessionRow
    res.json({ session: toSession(row) })
  })

  return router
}
