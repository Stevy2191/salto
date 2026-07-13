import { Router } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import type { Coach, Group, GymEvent, RequiredEvent, Session } from '../../shared/types.ts'
import { formatTime, parseTime } from '../../shared/slots.ts'
import { isHexColor, nextPaletteColor } from '../../shared/colors.ts'
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

interface EventRow {
  id: number
  name: string
  capacity: number
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

interface GroupRow {
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
  day_of_week: number
  start_time: string
  end_time: string
  rotation_length: number
  groups: string
  absent_coaches: string
  unavailable_events: string
  is_sample: number
}

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

const toGroup = (r: GroupRow): Group => ({
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
  dayOfWeek: r.day_of_week,
  startTime: r.start_time,
  endTime: r.end_time,
  rotationLength: r.rotation_length,
  groups: JSON.parse(r.groups) as number[],
  absentCoaches: JSON.parse(r.absent_coaches) as number[],
  unavailableEvents: JSON.parse(r.unavailable_events) as number[],
  isSample: r.is_sample === 1,
})

function parseEvent(body: unknown): {
  name: string
  capacity: number
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
    capacity: obj.capacity === undefined ? 1 : reqInt(obj.capacity, 'capacity', 1, 20),
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

function parseGroup(body: unknown): {
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
  dayOfWeek: number
  startTime: string
  endTime: string
  rotationLength: number
  groups: number[]
} {
  const obj = asObject(body)
  const startTime = reqString(obj.startTime, 'startTime', 5)
  const endTime = reqString(obj.endTime, 'endTime', 5)
  const start = parseTime(startTime)
  const end = parseTime(endTime)
  if (start === null) throw new ApiError(400, 'startTime must be HH:MM')
  if (end === null) throw new ApiError(400, 'endTime must be HH:MM')
  if (end <= start) throw new ApiError(400, 'endTime must be after startTime')
  const rotationLength =
    obj.rotationLength === undefined ? 15 : reqInt(obj.rotationLength, 'rotationLength', 5, 240)
  if (rotationLength % 5 !== 0) {
    throw new ApiError(400, 'rotationLength must be a multiple of 5 minutes')
  }
  return {
    name: optString(obj.name, 'name'),
    dayOfWeek: reqInt(obj.dayOfWeek, 'dayOfWeek', 0, 6),
    startTime,
    endTime,
    rotationLength,
    groups: intArray(obj.groups, 'groups'),
  }
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
      const groups = db.prepare('SELECT id, required_events AS col FROM groups').all() as {
        id: number
        col: string
      }[]
      for (const g of groups) {
        const entries = JSON.parse(g.col) as RequiredEvent[]
        if (entries.some((r) => r.eventId === id)) {
          db.prepare('UPDATE groups SET required_events = ? WHERE id = ?').run(
            JSON.stringify(entries.filter((r) => r.eventId !== id)),
            g.id,
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

  // --- Groups ---
  router.get('/groups', (_req, res) => {
    const rows = db.prepare('SELECT * FROM groups ORDER BY id').all() as unknown as GroupRow[]
    res.json({ groups: rows.map(toGroup) })
  })

  router.post('/groups', (req, res) => {
    const g = parseGroup(req.body)
    const result = db
      .prepare('INSERT INTO groups (name, priority, required_events, assigned_coaches) VALUES (?, ?, ?, ?)')
      .run(g.name, g.priority, JSON.stringify(g.requiredEvents), JSON.stringify(g.assignedCoaches))
    const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(result.lastInsertRowid) as unknown as GroupRow
    res.status(201).json({ group: toGroup(row) })
  })

  router.put('/groups/:id', (req, res) => {
    const id = idParam(req.params.id)
    const g = parseGroup(req.body)
    requireRow(db.prepare('SELECT id FROM groups WHERE id = ?').get(id), 'group')
    db.prepare(
      'UPDATE groups SET name = ?, priority = ?, required_events = ?, assigned_coaches = ? WHERE id = ?',
    ).run(g.name, g.priority, JSON.stringify(g.requiredEvents), JSON.stringify(g.assignedCoaches), id)
    const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as unknown as GroupRow
    res.json({ group: toGroup(row) })
  })

  router.delete('/groups/:id', (req, res) => {
    const id = idParam(req.params.id)
    requireRow(db.prepare('SELECT id FROM groups WHERE id = ?').get(id), 'group')
    withTransaction(db, () => {
      db.prepare('DELETE FROM groups WHERE id = ?').run(id)
      scrubIdFromJsonColumn(db, 'sessions', 'groups', id)
    })
    res.status(204).end()
  })

  // --- Sessions ---
  router.get('/sessions', (_req, res) => {
    const rows = db.prepare('SELECT * FROM sessions ORDER BY day_of_week, start_time').all() as unknown as SessionRow[]
    res.json({ sessions: rows.map(toSession) })
  })

  router.get('/sessions/:id', (req, res) => {
    const id = idParam(req.params.id)
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined
    requireRow(row, 'session')
    res.json({ session: toSession(row!) })
  })

  router.post('/sessions', (req, res) => {
    const s = parseSession(req.body)
    const result = db
      .prepare(
        'INSERT INTO sessions (name, day_of_week, start_time, end_time, rotation_length, groups) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(s.name, s.dayOfWeek, s.startTime, s.endTime, s.rotationLength, JSON.stringify(s.groups))
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(result.lastInsertRowid) as unknown as SessionRow
    res.status(201).json({ session: toSession(row) })
  })

  router.put('/sessions/:id', (req, res) => {
    const id = idParam(req.params.id)
    const s = parseSession(req.body)
    requireRow(db.prepare('SELECT id FROM sessions WHERE id = ?').get(id), 'session')
    db.prepare(
      'UPDATE sessions SET name = ?, day_of_week = ?, start_time = ?, end_time = ?, rotation_length = ?, groups = ? WHERE id = ?',
    ).run(s.name, s.dayOfWeek, s.startTime, s.endTime, s.rotationLength, JSON.stringify(s.groups), id)
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow
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
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow
    res.json({ session: toSession(row) })
  })

  // Copy a session as a starting point: same duration, rotation, groups,
  // and full schedule (assignments arrive unlocked); outages don't copy.
  router.post('/sessions/:id/copy', (req, res) => {
    const id = idParam(req.params.id)
    const source = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as
      | SessionRow
      | undefined
    requireRow(source, 'session')
    const obj = asObject(req.body)
    const name = optString(obj.name, 'name')
    const dayOfWeek = reqInt(obj.dayOfWeek, 'dayOfWeek', 0, 6)
    const startTime = reqString(obj.startTime, 'startTime', 5)
    const start = parseTime(startTime)
    if (start === null) throw new ApiError(400, 'startTime must be HH:MM')
    const sourceStart = parseTime(source!.start_time)!
    const sourceEnd = parseTime(source!.end_time)!
    const end = start + (sourceEnd - sourceStart)
    if (end > 24 * 60) {
      throw new ApiError(400, 'the copied session would run past midnight — pick an earlier start')
    }

    const newId = withTransaction(db, () => {
      const inserted = db
        .prepare(
          'INSERT INTO sessions (name, day_of_week, start_time, end_time, rotation_length, groups) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          name,
          dayOfWeek,
          startTime,
          formatTime(end),
          source!.rotation_length,
          source!.groups,
        )
      const sessionId = Number(inserted.lastInsertRowid)
      db.prepare(
        `INSERT INTO assignments (session_id, slot_index, event_id, group_id, coach_id, locked)
         SELECT ?, slot_index, event_id, group_id, coach_id, 0 FROM assignments WHERE session_id = ?`,
      ).run(sessionId, id)
      return sessionId
    })
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(newId) as unknown as SessionRow
    res.status(201).json({ session: toSession(row) })
  })

  return router
}
