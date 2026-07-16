import { Router } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import type {
  ClassWindow,
  Coach,
  GymClass,
  GymEvent,
  Program,
  Session,
} from '../../shared/types.ts'
import { PLAN_WEEKS } from '../../shared/types.ts'
import { SLOT_MINUTES, formatTime, isSnapped, parseTime } from '../../shared/slots.ts'
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
  /** Kept in sync with `shared` (shared → NULL, exclusive → 1) for the solver. */
  capacity: number | null
  duration_minutes: number
  shared: number
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
  program_id: number | null
  priority: number
  eligible_events: string
  period_minutes: number
  warmup_event_id: number | null
  warmup_minutes: number
  cooldown_event_id: number | null
  cooldown_minutes: number
  assigned_coaches: string
  is_sample: number
}

interface ProgramRow {
  id: number
  name: string
  default_start_time: string | null
  default_end_time: string | null
  is_sample: number
}

interface SessionRow {
  id: number
  name: string
  date: string
  start_time: string
  end_time: string
  column_count: number
  week_locks: string
  plan_warnings: string
  absent_coaches: string
  unavailable_events: string
  is_sample: number
  /** Derived, not stored: how many distinct classes attend, any week. */
  class_count: number
}

// Attendance lives in the plan now, so a session's class count is derived
// from its placements (across all weeks) rather than kept as a second
// source of truth.
const SESSION_SELECT = `SELECT s.*, (
  SELECT COUNT(DISTINCT class_id) FROM placements WHERE session_id = s.id
) AS class_count FROM sessions s`

const toEvent = (r: EventRow): GymEvent => ({
  id: r.id,
  name: r.name,
  duration: r.duration_minutes,
  shared: r.shared === 1,
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
  programId: r.program_id,
  priority: r.priority,
  eligibleEventIds: JSON.parse(r.eligible_events) as number[],
  periodMinutes: r.period_minutes,
  warmupEventId: r.warmup_event_id,
  warmupMinutes: r.warmup_minutes,
  cooldownEventId: r.cooldown_event_id,
  cooldownMinutes: r.cooldown_minutes,
  assignedCoaches: JSON.parse(r.assigned_coaches) as number[],
  isSample: r.is_sample === 1,
})

const toProgram = (r: ProgramRow): Program => ({
  id: r.id,
  name: r.name,
  defaultStartTime: r.default_start_time,
  defaultEndTime: r.default_end_time,
  isSample: r.is_sample === 1,
})

/** An optional "HH:MM" that must snap to the grid when present. */
function optTime(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new ApiError(400, `${field} must be a time like 16:00`)
  const min = parseTime(value)
  if (min === null) throw new ApiError(400, `${field} must be HH:MM`)
  if (!isSnapped(min)) throw new ApiError(400, `${field} must land on a 5-minute boundary`)
  return value
}

/** A start/end pair is all-or-nothing, and must run forwards. */
function optWindow(
  body: Record<string, unknown>,
  what: string,
): { start: string | null; end: string | null } {
  const start = optTime(body.defaultStartTime, 'defaultStartTime')
  const end = optTime(body.defaultEndTime, 'defaultEndTime')
  if ((start === null) !== (end === null)) {
    throw new ApiError(400, `${what} needs both a default start and end time, or neither`)
  }
  if (start !== null && end !== null && parseTime(end)! <= parseTime(start)!) {
    throw new ApiError(400, `${what}'s default end time must be after its start`)
  }
  return { start, end }
}

function parseProgram(body: unknown): {
  name: string
  start: string | null
  end: string | null
} {
  const obj = asObject(body)
  return { name: reqString(obj.name, 'name'), ...optWindow(obj, 'a program') }
}

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  name: r.name,
  date: r.date,
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

function parseEvent(body: unknown): {
  name: string
  duration: number
  shared: boolean
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
  const duration = obj.duration === undefined ? 10 : reqInt(obj.duration, 'duration', 5, 8 * 60)
  if (duration % SLOT_MINUTES !== 0) {
    throw new ApiError(400, `duration must be a multiple of ${SLOT_MINUTES} minutes`)
  }
  return {
    name: reqString(obj.name, 'name'),
    duration,
    shared: obj.shared === undefined ? false : reqBool(obj.shared, 'shared'),
    active: obj.active === undefined ? true : reqBool(obj.active, 'active'),
    color,
  }
}

/** capacity mirrors shared for the solver: shared → unlimited, else one. */
const capacityFor = (shared: boolean) => (shared ? null : 1)

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

/** An optional fixed block (warm-up / cool-down): an event and its minutes. */
function optBlock(
  obj: Record<string, unknown>,
  eventField: string,
  minutesField: string,
  what: string,
): { eventId: number | null; minutes: number } {
  const rawId = obj[eventField]
  const eventId =
    rawId === undefined || rawId === null ? null : reqInt(rawId, eventField, 1, MAX_ID)
  const minutes = obj[minutesField] === undefined ? 0 : reqInt(obj[minutesField], minutesField, 0, 8 * 60)
  if (minutes % SLOT_MINUTES !== 0) {
    throw new ApiError(400, `${what} length must be a multiple of ${SLOT_MINUTES} minutes`)
  }
  if ((eventId === null) !== (minutes === 0)) {
    throw new ApiError(400, `a ${what} needs both an event and a length, or neither`)
  }
  return { eventId, minutes }
}

const MAX_ID = Number.MAX_SAFE_INTEGER

function parseClass(body: unknown): {
  name: string
  programId: number | null
  priority: number
  eligibleEventIds: number[]
  periodMinutes: number
  warmupEventId: number | null
  warmupMinutes: number
  cooldownEventId: number | null
  cooldownMinutes: number
  assignedCoaches: number[]
} {
  const obj = asObject(body)
  const eligibleEventIds = intArray(obj.eligibleEventIds, 'eligibleEventIds')
  const periodMinutes = obj.periodMinutes === undefined ? 45 : reqInt(obj.periodMinutes, 'periodMinutes', 5, 12 * 60)
  if (periodMinutes % SLOT_MINUTES !== 0) {
    throw new ApiError(400, `periodMinutes must be a multiple of ${SLOT_MINUTES} minutes`)
  }
  const warmup = optBlock(obj, 'warmupEventId', 'warmupMinutes', 'warm-up')
  const cooldown = optBlock(obj, 'cooldownEventId', 'cooldownMinutes', 'cool-down')
  if (warmup.minutes + cooldown.minutes > periodMinutes) {
    throw new ApiError(400, "the warm-up and cool-down don't leave any time in the period")
  }
  return {
    name: reqString(obj.name, 'name'),
    programId:
      obj.programId === undefined || obj.programId === null
        ? null
        : reqInt(obj.programId, 'programId', 1, MAX_ID),
    priority: obj.priority === undefined ? 0 : reqInt(obj.priority, 'priority', 0, 100),
    eligibleEventIds,
    periodMinutes,
    warmupEventId: warmup.eventId,
    warmupMinutes: warmup.minutes,
    cooldownEventId: cooldown.eventId,
    cooldownMinutes: cooldown.minutes,
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
      .prepare(
        'INSERT INTO events (name, duration_minutes, shared, capacity, active, color) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        e.name,
        e.duration,
        e.shared ? 1 : 0,
        capacityFor(e.shared),
        e.active ? 1 : 0,
        e.color ?? defaultEventColor(db),
      )
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
    db.prepare(
      'UPDATE events SET name = ?, duration_minutes = ?, shared = ?, capacity = ?, active = ?, color = ? WHERE id = ?',
    ).run(
      e.name,
      e.duration,
      e.shared ? 1 : 0,
      capacityFor(e.shared),
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
      // A deleted event drops out of every class's eligibility, and out of
      // any warm-up/cool-down slot (the FK nulls those). Its schedule blocks
      // cascade.
      db.prepare('DELETE FROM events WHERE id = ?').run(id)
      scrubIdFromJsonColumn(db, 'coaches', 'specialties', id)
      scrubIdFromJsonColumn(db, 'groups', 'eligible_events', id)
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

  // --- Programs ---
  router.get('/programs', (_req, res) => {
    const rows = db.prepare('SELECT * FROM programs ORDER BY id').all() as unknown as ProgramRow[]
    res.json({ programs: rows.map(toProgram) })
  })

  router.post('/programs', (req, res) => {
    const p = parseProgram(req.body)
    const result = db
      .prepare('INSERT INTO programs (name, default_start_time, default_end_time) VALUES (?, ?, ?)')
      .run(p.name, p.start, p.end)
    const row = db
      .prepare('SELECT * FROM programs WHERE id = ?')
      .get(result.lastInsertRowid) as unknown as ProgramRow
    res.status(201).json({ program: toProgram(row) })
  })

  router.put('/programs/:id', (req, res) => {
    const id = idParam(req.params.id)
    const p = parseProgram(req.body)
    requireRow(db.prepare('SELECT id FROM programs WHERE id = ?').get(id), 'program')
    db.prepare(
      'UPDATE programs SET name = ?, default_start_time = ?, default_end_time = ? WHERE id = ?',
    ).run(p.name, p.start, p.end, id)
    const row = db.prepare('SELECT * FROM programs WHERE id = ?').get(id) as unknown as ProgramRow
    res.json({ program: toProgram(row) })
  })

  // Refused while classes still point at it, rather than orphaning them —
  // a class without a program cannot be generated from.
  router.delete('/programs/:id', (req, res) => {
    const id = idParam(req.params.id)
    requireRow(db.prepare('SELECT id FROM programs WHERE id = ?').get(id), 'program')
    const held = db
      .prepare('SELECT COUNT(*) AS n FROM groups WHERE program_id = ?')
      .get(id) as { n: number }
    if (held.n > 0) {
      throw new ApiError(
        400,
        `${held.n} class${held.n === 1 ? '' : 'es'} still belong${held.n === 1 ? 's' : ''} to this program — move or delete them first`,
      )
    }
    db.prepare('DELETE FROM programs WHERE id = ?').run(id)
    res.status(204).end()
  })

  // --- Classes ---
  router.get('/classes', (_req, res) => {
    const rows = db.prepare('SELECT * FROM groups ORDER BY id').all() as unknown as ClassRow[]
    res.json({ classes: rows.map(toClass) })
  })

  const requireProgram = (programId: number | null) => {
    if (programId === null) return
    requireRow(db.prepare('SELECT id FROM programs WHERE id = ?').get(programId), 'program')
  }

  router.post('/classes', (req, res) => {
    const c = parseClass(req.body)
    requireProgram(c.programId)
    const result = db
      .prepare(
        `INSERT INTO groups (name, program_id, priority, eligible_events, period_minutes,
                             warmup_event_id, warmup_minutes, cooldown_event_id, cooldown_minutes,
                             assigned_coaches)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.name,
        c.programId,
        c.priority,
        JSON.stringify(c.eligibleEventIds),
        c.periodMinutes,
        c.warmupEventId,
        c.warmupMinutes,
        c.cooldownEventId,
        c.cooldownMinutes,
        JSON.stringify(c.assignedCoaches),
      )
    const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(result.lastInsertRowid) as unknown as ClassRow
    res.status(201).json({ class: toClass(row) })
  })

  router.put('/classes/:id', (req, res) => {
    const id = idParam(req.params.id)
    const c = parseClass(req.body)
    requireRow(db.prepare('SELECT id FROM groups WHERE id = ?').get(id), 'class')
    requireProgram(c.programId)
    db.prepare(
      `UPDATE groups SET name = ?, program_id = ?, priority = ?, eligible_events = ?,
                         period_minutes = ?, warmup_event_id = ?, warmup_minutes = ?,
                         cooldown_event_id = ?, cooldown_minutes = ?, assigned_coaches = ?
       WHERE id = ?`,
    ).run(
      c.name,
      c.programId,
      c.priority,
      JSON.stringify(c.eligibleEventIds),
      c.periodMinutes,
      c.warmupEventId,
      c.warmupMinutes,
      c.cooldownEventId,
      c.cooldownMinutes,
      JSON.stringify(c.assignedCoaches),
      id,
    )
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

  // `classes` seeds attendance for the new plan: each class runs the whole
  // session window in its own column, in every week, ready for Generate.
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
        'INSERT INTO placements (session_id, class_id, column_index, week, start_min, end_min) VALUES (?, ?, ?, ?, ?, ?)',
      )
      s.classes.forEach((classId, index) => {
        for (let week = 1; week <= PLAN_WEEKS; week++) {
          insert.run(id, classId, index, week, startMin, endMin)
        }
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
          'SELECT id, class_id, column_index, week, start_min, end_min FROM placements WHERE session_id = ?',
        )
        .all(id) as {
        id: number
        class_id: number
        column_index: number
        week: number
        start_min: number
        end_min: number
      }[]
      const insertPlacement = db.prepare(
        'INSERT INTO placements (session_id, class_id, column_index, week, start_min, end_min) VALUES (?, ?, ?, ?, ?, ?)',
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
            p.week,
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
