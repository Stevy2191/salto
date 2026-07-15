import { Router } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import type {
  ClassWindow,
  Coach,
  GymClass,
  GymEvent,
  RequiredEvent,
  Session,
} from '../../shared/types.ts'
import { formatTime, isSnapped, parseTime } from '../../shared/slots.ts'
import { isHexColor, nextPaletteColor } from '../../shared/colors.ts'
import { isIsoDate } from '../../shared/dates.ts'
import {
  ApiError,
  asObject,
  idParam,
  intArray,
  optString,
  reqBool,
  reqInt,
  reqString,
} from '../validate.ts'
import { withTransaction } from '../tx.ts'

// Storage note: classes were called "groups" before the rename, and SQLite
// keeps the original names (`groups` table, `sessions.groups` column,
// `assignments.group_id`) so deployed databases never needed a risky rename
// migration. These mappers are the translation boundary — nothing above
// them says "group".

interface EventRow {
  id: number
  name: string
  capacity: number | null
  active: number
  color: string
  is_sample: number
}

interface CoachRow {
  id: number
  name: string
  specialties: string
  availability: string
  is_sample: number
}

interface ClassRow {
  id: number
  name: string
  priority: number
  required_events: string
  assigned_coaches: string
  is_sample: number
}

interface SessionRow {
  id: number
  name: string
  date: string
  start_time: string
  end_time: string
  column_count: number
  absent_coaches: string
  unavailable_events: string
  is_sample: number
  /** Derived, not stored: how many classes the grid actually holds. */
  class_count: number
}

// Attendance lives in the grid now, so a session's class count is derived
// from its placements rather than kept as a second source of truth.
const SESSION_SELECT = `SELECT s.*, (
  SELECT COUNT(DISTINCT class_id) FROM placements WHERE session_id = s.id
) AS class_count FROM sessions s`

const toEvent = (r: EventRow): GymEvent => ({
  id: r.id,
  name: r.name,
  capacity: r.capacity,
  active: r.active === 1,
  color: r.color,
  isSample: r.is_sample === 1,
})

const toCoach = (r: CoachRow): Coach => ({
  id: r.id,
  name: r.name,
  specialties: JSON.parse(r.specialties) as number[],
  availability: JSON.parse(r.availability) as number[],
  isSample: r.is_sample === 1,
})

const toClass = (r: ClassRow): GymClass => ({
  id: r.id,
  name: r.name,
  priority: r.priority,
  requiredEvents: JSON.parse(r.required_events) as RequiredEvent[],
  assignedCoaches: JSON.parse(r.assigned_coaches) as number[],
  isSample: r.is_sample === 1,
})

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  name: r.name,
  date: r.date,
  startTime: r.start_time,
  endTime: r.end_time,
  columnCount: r.column_count,
  classCount: r.class_count,
  absentCoaches: JSON.parse(r.absent_coaches) as number[],
  unavailableEvents: JSON.parse(r.unavailable_events) as number[],
  isSample: r.is_sample === 1,
})

function parseEvent(body: unknown): {
  name: string
  capacity: number | null
  active: boolean
  color?: string
} {
  const obj = asObject(body)
  let color: string | undefined
  if (obj.color !== undefined) {
    if (!isHexColor(obj.color)) {
      throw new ApiError(400, 'color must be a hex color like #4E79A7')
    }
    color = obj.color.toUpperCase()
  }
  return {
    name: reqString(obj.name, 'name'),
    // Omitted or null = no limit on simultaneous classes.
    capacity:
      obj.capacity === undefined || obj.capacity === null
        ? null
        : reqInt(obj.capacity, 'capacity', 1, 20),
    active: obj.active === undefined ? true : reqBool(obj.active, 'active'),
    color,
  }
}

/** Default for new events: the next palette color not yet in use. */
function defaultEventColor(db: DatabaseSync): string {
  const rows = db.prepare('SELECT color FROM events').all() as { color: string }[]
  return nextPaletteColor(rows.map((r) => r.color))
}

function parseCoach(body: unknown): { name: string; specialties: number[]; availability: number[] } {
  const obj = asObject(body)
  const availability = intArray(obj.availability, 'availability')
  if (availability.some((d) => d < 0 || d > 6)) {
    throw new ApiError(400, 'availability days must be 0 (Sunday) through 6 (Saturday)')
  }
  return {
    name: reqString(obj.name, 'name'),
    specialties: intArray(obj.specialties, 'specialties'),
    availability,
  }
}

function parseClass(body: unknown): {
  name: string
  priority: number
  requiredEvents: RequiredEvent[]
  assignedCoaches: number[]
} {
  const obj = asObject(body)
  const rawRequired = obj.requiredEvents ?? []
  if (!Array.isArray(rawRequired)) throw new ApiError(400, 'requiredEvents must be an array')
  const requiredEvents = rawRequired.map((entry): RequiredEvent => {
    const e = asObject(entry)
    const duration = reqInt(e.duration, 'requiredEvents.duration', 5, 24 * 60)
    if (duration % 5 !== 0) {
      throw new ApiError(400, 'requiredEvents.duration must be a multiple of 5 minutes')
    }
    return {
      eventId: reqInt(e.eventId, 'requiredEvents.eventId', 1, Number.MAX_SAFE_INTEGER),
      duration,
    }
  })
  return {
    name: reqString(obj.name, 'name'),
    priority: obj.priority === undefined ? 0 : reqInt(obj.priority, 'priority', 0, 100),
    requiredEvents,
    assignedCoaches: intArray(obj.assignedCoaches, 'assignedCoaches'),
  }
}

function parseSession(body: unknown): {
  name: string
  date: string
  startTime: string
  endTime: string
  /** Classes to seed the grid with, each a full-window column of its own. */
  classes: number[]
} {
  const obj = asObject(body)
  const date = reqIsoDate(obj.date, 'date')
  const startTime = reqString(obj.startTime, 'startTime', 5)
  const endTime = reqString(obj.endTime, 'endTime', 5)
  const start = parseTime(startTime)
  const end = parseTime(endTime)
  if (start === null) throw new ApiError(400, 'startTime must be HH:MM')
  if (end === null) throw new ApiError(400, 'endTime must be HH:MM')
  if (end <= start) throw new ApiError(400, 'endTime must be after startTime')
  if (!isSnapped(start) || !isSnapped(end)) {
    throw new ApiError(400, 'session times must land on 5-minute boundaries')
  }
  return {
    name: optString(obj.name, 'name'),
    date,
    startTime,
    endTime,
    classes: intArray(obj.classes, 'classes'),
  }
}

function reqIsoDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isIsoDate(value)) {
    throw new ApiError(400, `${field} must be a real calendar date like 2026-03-03`)
  }
  return value
}

function requireRow(row: unknown, what: string): void {
  if (!row) throw new ApiError(404, `${what} not found`)
}

/** Remove an id from a JSON int-array column on every row of a table. */
function scrubIdFromJsonColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  id: number,
): void {
  const rows = db.prepare(`SELECT id, ${column} AS col FROM ${table}`).all() as {
    id: number
    col: string
  }[]
  for (const row of rows) {
    const ids = JSON.parse(row.col) as number[]
    if (ids.includes(id)) {
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(
        JSON.stringify(ids.filter((x) => x !== id)),
        row.id,
      )
    }
  }
}

export function entityRoutes(db: DatabaseSync): Router {
  const router = Router()

  // --- Events ---
  router.get('/events', (_req, res) => {
    const rows = db.prepare('SELECT * FROM events ORDER BY id').all() as unknown as EventRow[]
    res.json({ events: rows.map(toEvent) })
  })

  router.post('/events', (req, res) => {
    const e = parseEvent(req.body)
    const result = db
      .prepare('INSERT INTO events (name, capacity, active, color) VALUES (?, ?, ?, ?)')
      .run(e.name, e.capacity, e.active ? 1 : 0, e.color ?? defaultEventColor(db))
    const row = db.prepare('SELECT * FROM events WHERE id = ?').get(result.lastInsertRowid) as unknown as EventRow
    res.status(201).json({ event: toEvent(row) })
  })

  router.put('/events/:id', (req, res) => {
    const id = idParam(req.params.id)
    const e = parseEvent(req.body)
    const existing = db.prepare('SELECT color FROM events WHERE id = ?').get(id) as
      | { color: string }
      | undefined
    requireRow(existing, 'event')
    db.prepare('UPDATE events SET name = ?, capacity = ?, active = ?, color = ? WHERE id = ?').run(
      e.name,
      e.capacity,
      e.active ? 1 : 0,
      e.color ?? existing!.color,
      id,
    )
    const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as unknown as EventRow
    res.json({ event: toEvent(row) })
  })

  router.delete('/events/:id', (req, res) => {
    const id = idParam(req.params.id)
    requireRow(db.prepare('SELECT id FROM events WHERE id = ?').get(id), 'event')
    withTransaction(db, () => {
      db.prepare('DELETE FROM events WHERE id = ?').run(id)
      scrubIdFromJsonColumn(db, 'coaches', 'specialties', id)
      // requiredEvents entries are objects, handled separately below.
      const classes = db.prepare('SELECT id, required_events AS col FROM groups').all() as {
        id: number
        col: string
      }[]
      for (const c of classes) {
        const entries = JSON.parse(c.col) as RequiredEvent[]
        if (entries.some((r) => r.eventId === id)) {
          db.prepare('UPDATE groups SET required_events = ? WHERE id = ?').run(
            JSON.stringify(entries.filter((r) => r.eventId !== id)),
            c.id,
          )
        }
      }
    })
    res.status(204).end()
  })

  // --- Coaches ---
  router.get('/coaches', (_req, res) => {
    const rows = db.prepare('SELECT * FROM coaches ORDER BY id').all() as unknown as CoachRow[]
    res.json({ coaches: rows.map(toCoach) })
  })

  router.post('/coaches', (req, res) => {
    const c = parseCoach(req.body)
    const result = db
      .prepare('INSERT INTO coaches (name, specialties, availability) VALUES (?, ?, ?)')
      .run(c.name, JSON.stringify(c.specialties), JSON.stringify(c.availability))
    const row = db.prepare('SELECT * FROM coaches WHERE id = ?').get(result.lastInsertRowid) as unknown as CoachRow
    res.status(201).json({ coach: toCoach(row) })
  })

  router.put('/coaches/:id', (req, res) => {
    const id = idParam(req.params.id)
    const c = parseCoach(req.body)
    requireRow(db.prepare('SELECT id FROM coaches WHERE id = ?').get(id), 'coach')
    db.prepare('UPDATE coaches SET name = ?, specialties = ?, availability = ? WHERE id = ?').run(
      c.name,
      JSON.stringify(c.specialties),
      JSON.stringify(c.availability),
      id,
    )
    const row = db.prepare('SELECT * FROM coaches WHERE id = ?').get(id) as unknown as CoachRow
    res.json({ coach: toCoach(row) })
  })

  router.delete('/coaches/:id', (req, res) => {
    const id = idParam(req.params.id)
    requireRow(db.prepare('SELECT id FROM coaches WHERE id = ?').get(id), 'coach')
    withTransaction(db, () => {
      db.prepare('DELETE FROM coaches WHERE id = ?').run(id)
      scrubIdFromJsonColumn(db, 'groups', 'assigned_coaches', id)
    })
    res.status(204).end()
  })

  // --- Classes ---
  router.get('/classes', (_req, res) => {
    const rows = db.prepare('SELECT * FROM groups ORDER BY id').all() as unknown as ClassRow[]
    res.json({ classes: rows.map(toClass) })
  })

  router.post('/classes', (req, res) => {
    const c = parseClass(req.body)
    const result = db
      .prepare('INSERT INTO groups (name, priority, required_events, assigned_coaches) VALUES (?, ?, ?, ?)')
      .run(c.name, c.priority, JSON.stringify(c.requiredEvents), JSON.stringify(c.assignedCoaches))
    const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(result.lastInsertRowid) as unknown as ClassRow
    res.status(201).json({ class: toClass(row) })
  })

  router.put('/classes/:id', (req, res) => {
    const id = idParam(req.params.id)
    const c = parseClass(req.body)
    requireRow(db.prepare('SELECT id FROM groups WHERE id = ?').get(id), 'class')
    db.prepare(
      'UPDATE groups SET name = ?, priority = ?, required_events = ?, assigned_coaches = ? WHERE id = ?',
    ).run(c.name, c.priority, JSON.stringify(c.requiredEvents), JSON.stringify(c.assignedCoaches), id)
    const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as unknown as ClassRow
    res.json({ class: toClass(row) })
  })

  // The windows a class is placed in, across every session — what the class
  // form needs to say whether its required events fit.
  router.get('/classes/:id/windows', (req, res) => {
    const id = idParam(req.params.id)
    requireRow(db.prepare('SELECT id FROM groups WHERE id = ?').get(id), 'class')
    const rows = db
      .prepare(
        `SELECT p.session_id, s.name, s.date, p.start_min, p.end_min
         FROM placements p JOIN sessions s ON s.id = p.session_id
         WHERE p.class_id = ?
         ORDER BY s.date, p.start_min`,
      )
      .all(id) as {
      session_id: number
      name: string
      date: string
      start_min: number
      end_min: number
    }[]
    res.json({
      windows: rows.map(
        (r): ClassWindow => ({
          sessionId: r.session_id,
          sessionName: r.name,
          date: r.date,
          startMin: r.start_min,
          endMin: r.end_min,
        }),
      ),
    })
  })

  router.delete('/classes/:id', (req, res) => {
    const id = idParam(req.params.id)
    requireRow(db.prepare('SELECT id FROM groups WHERE id = ?').get(id), 'class')
    // Placements (and their blocks) cascade — a deleted class leaves the
    // lane behind, not a ghost placement.
    db.prepare('DELETE FROM groups WHERE id = ?').run(id)
    res.status(204).end()
  })

  // --- Sessions ---
  router.get('/sessions', (_req, res) => {
    const rows = db.prepare(`${SESSION_SELECT} ORDER BY s.date, s.start_time`).all() as unknown as SessionRow[]
    res.json({ sessions: rows.map(toSession) })
  })

  router.get('/sessions/:id', (req, res) => {
    const id = idParam(req.params.id)
    const row = db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as unknown as SessionRow | undefined
    requireRow(row, 'session')
    res.json({ session: toSession(row!) })
  })

  // `classes` is a convenience for creating a session with a starting grid:
  // each class lands in its own column running the whole window, which is a
  // sensible default to then edit down into real per-class windows.
  router.post('/sessions', (req, res) => {
    const s = parseSession(req.body)
    const startMin = parseTime(s.startTime)!
    const endMin = parseTime(s.endTime)!
    const sessionId = withTransaction(db, () => {
      const result = db
        .prepare(
          'INSERT INTO sessions (name, date, start_time, end_time, column_count) VALUES (?, ?, ?, ?, ?)',
        )
        .run(s.name, s.date, s.startTime, s.endTime, s.classes.length)
      const id = Number(result.lastInsertRowid)
      const insert = db.prepare(
        'INSERT INTO placements (session_id, class_id, column_index, start_min, end_min) VALUES (?, ?, ?, ?, ?)',
      )
      s.classes.forEach((classId, index) => {
        insert.run(id, classId, index, startMin, endMin)
      })
      return id
    })
    const row = db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(sessionId) as unknown as SessionRow
    res.status(201).json({ session: toSession(row) })
  })

  // Editing a session's window never touches its grid; `classes` is ignored
  // here because placements own attendance once a session exists.
  router.put('/sessions/:id', (req, res) => {
    const id = idParam(req.params.id)
    const s = parseSession(req.body)
    requireRow(db.prepare('SELECT id FROM sessions WHERE id = ?').get(id), 'session')
    const startMin = parseTime(s.startTime)!
    const endMin = parseTime(s.endTime)!
    const outside = db
      .prepare(
        'SELECT COUNT(*) AS n FROM placements WHERE session_id = ? AND (start_min < ? OR end_min > ?)',
      )
      .get(id, startMin, endMin) as { n: number }
    if (outside.n > 0) {
      throw new ApiError(
        400,
        `${outside.n} class placement${outside.n === 1 ? '' : 's'} would fall outside the new session window — move them first`,
      )
    }
    db.prepare(
      'UPDATE sessions SET name = ?, date = ?, start_time = ?, end_time = ? WHERE id = ?',
    ).run(s.name, s.date, s.startTime, s.endTime, id)
    const row = db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as unknown as SessionRow
    res.json({ session: toSession(row) })
  })

  // Columns are lanes, not classes: you can add empty ones to place into.
  router.put('/sessions/:id/columns', (req, res) => {
    const id = idParam(req.params.id)
    requireRow(db.prepare('SELECT id FROM sessions WHERE id = ?').get(id), 'session')
    const obj = asObject(req.body)
    const columnCount = reqInt(obj.columnCount, 'columnCount', 0, 64)
    const used = db
      .prepare('SELECT COUNT(*) AS n FROM placements WHERE session_id = ? AND column_index >= ?')
      .get(id, columnCount) as { n: number }
    if (used.n > 0) {
      throw new ApiError(400, 'a column still holds classes — move or remove them first')
    }
    db.prepare('UPDATE sessions SET column_count = ? WHERE id = ?').run(columnCount, id)
    const row = db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as unknown as SessionRow
    res.json({ session: toSession(row) })
  })

  router.delete('/sessions/:id', (req, res) => {
    const id = idParam(req.params.id)
    requireRow(db.prepare('SELECT id FROM sessions WHERE id = ?').get(id), 'session')
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    res.status(204).end()
  })

  // Day-of outages, session-scoped. Kept separate from the session form's
  // PUT so editing a session never clears them.
  router.put('/sessions/:id/outages', (req, res) => {
    const id = idParam(req.params.id)
    requireRow(db.prepare('SELECT id FROM sessions WHERE id = ?').get(id), 'session')
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

  // Copy a session as a starting point: same window length, columns, class
  // placements, and painted blocks (arriving unlocked); outages don't copy.
  // Shifting the start shifts every placement and block with it, so the
  // grid lands identical, just later or earlier in the day.
  router.post('/sessions/:id/copy', (req, res) => {
    const id = idParam(req.params.id)
    const source = db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as unknown as
      | SessionRow
      | undefined
    requireRow(source, 'session')
    const obj = asObject(req.body)
    const name = optString(obj.name, 'name')
    const date = reqIsoDate(obj.date, 'date')
    // Copying the same week over usually keeps the time — default to the
    // source's start rather than making the user retype it.
    const startTime =
      obj.startTime === undefined ? source!.start_time : reqString(obj.startTime, 'startTime', 5)
    const start = parseTime(startTime)
    if (start === null) throw new ApiError(400, 'startTime must be HH:MM')
    const sourceStart = parseTime(source!.start_time)!
    const sourceEnd = parseTime(source!.end_time)!
    const end = start + (sourceEnd - sourceStart)
    if (end > 24 * 60) {
      throw new ApiError(400, 'the copied session would run past midnight — pick an earlier start')
    }

    const shift = start - sourceStart
    const newId = withTransaction(db, () => {
      const inserted = db
        .prepare(
          'INSERT INTO sessions (name, date, start_time, end_time, column_count) VALUES (?, ?, ?, ?, ?)',
        )
        .run(name, date, startTime, formatTime(end), source!.column_count)
      const sessionId = Number(inserted.lastInsertRowid)
      const placements = db
        .prepare(
          'SELECT id, class_id, column_index, start_min, end_min FROM placements WHERE session_id = ?',
        )
        .all(id) as {
        id: number
        class_id: number
        column_index: number
        start_min: number
        end_min: number
      }[]
      const insertPlacement = db.prepare(
        'INSERT INTO placements (session_id, class_id, column_index, start_min, end_min) VALUES (?, ?, ?, ?, ?)',
      )
      const insertBlock = db.prepare(
        'INSERT INTO event_blocks (placement_id, event_id, coach_id, start_min, end_min, locked) VALUES (?, ?, ?, ?, ?, 0)',
      )
      for (const p of placements) {
        const newPlacementId = Number(
          insertPlacement.run(
            sessionId,
            p.class_id,
            p.column_index,
            p.start_min + shift,
            p.end_min + shift,
          ).lastInsertRowid,
        )
        const blocks = db
          .prepare(
            'SELECT event_id, coach_id, start_min, end_min FROM event_blocks WHERE placement_id = ?',
          )
          .all(p.id) as {
          event_id: number
          coach_id: number | null
          start_min: number
          end_min: number
        }[]
        for (const b of blocks) {
          insertBlock.run(
            newPlacementId,
            b.event_id,
            b.coach_id,
            b.start_min + shift,
            b.end_min + shift,
          )
        }
      }
      return sessionId
    })
    const row = db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(newId) as unknown as SessionRow
    res.status(201).json({ session: toSession(row) })
  })

  return router
}
