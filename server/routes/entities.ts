import { Router } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import type { Coach, GymClass, GymEvent, Program } from '../../shared/types.ts'
import { SLOT_MINUTES, isSnapped, parseTime } from '../../shared/slots.ts'
import { isHexColor, nextPaletteColor } from '../../shared/colors.ts'
import { ApiError, asObject, idParam, intArray, reqBool, reqInt, reqString } from '../validate.ts'
import { withTransaction } from '../tx.ts'
import { reconcileSessions } from './sessions.ts'

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
  days_of_week: string
  start_time: string | null
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

const toEvent = (r: EventRow): GymEvent => ({
  id: r.id,
  name: r.name,
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
  daysOfWeek: JSON.parse(r.days_of_week) as number[],
  startTime: r.start_time,
  eligibleEvents: JSON.parse(r.eligible_events) as GymClass['eligibleEvents'],
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

function parseEvent(body: unknown): {
  name: string
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
  return {
    name: reqString(obj.name, 'name'),
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

function parseEligibleEvents(value: unknown): { eventId: number; minutes: number }[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ApiError(400, 'eligibleEvents must be an array')
  const seen = new Set<number>()
  return value.map((raw) => {
    const obj = asObject(raw)
    const eventId = reqInt(obj.eventId, 'eligibleEvents.eventId', 1, MAX_ID)
    if (seen.has(eventId)) throw new ApiError(400, 'eligibleEvents lists the same event twice')
    seen.add(eventId)
    const minutes = reqInt(obj.minutes, 'eligibleEvents.minutes', SLOT_MINUTES, 8 * 60)
    if (minutes % SLOT_MINUTES !== 0) {
      throw new ApiError(400, `eligibleEvents minutes must be a multiple of ${SLOT_MINUTES}`)
    }
    return { eventId, minutes }
  })
}

function parseClass(body: unknown): {
  name: string
  programId: number | null
  priority: number
  daysOfWeek: number[]
  startTime: string | null
  eligibleEvents: { eventId: number; minutes: number }[]
  periodMinutes: number
  warmupEventId: number | null
  warmupMinutes: number
  cooldownEventId: number | null
  cooldownMinutes: number
  assignedCoaches: number[]
} {
  const obj = asObject(body)
  const daysOfWeek = intArray(obj.daysOfWeek, 'daysOfWeek')
  if (daysOfWeek.some((d) => d < 0 || d > 6)) {
    throw new ApiError(400, 'daysOfWeek must be 0 (Sunday) through 6 (Saturday)')
  }
  const startTime = optTime(obj.startTime, 'startTime')
  const eligibleEvents = parseEligibleEvents(obj.eligibleEvents)
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
    daysOfWeek: [...new Set(daysOfWeek)].sort((a, b) => a - b),
    startTime,
    eligibleEvents,
    periodMinutes,
    warmupEventId: warmup.eventId,
    warmupMinutes: warmup.minutes,
    cooldownEventId: cooldown.eventId,
    cooldownMinutes: cooldown.minutes,
    assignedCoaches: intArray(obj.assignedCoaches, 'assignedCoaches'),
  }
}

function requireRow(row: unknown, what: string): void {
  if (!row) throw new ApiError(404, `${what} not found`)
}

/** Drop a deleted event from every class's eligible-events list of objects. */
function scrubEligibleEvent(db: DatabaseSync, eventId: number): void {
  const rows = db.prepare('SELECT id, eligible_events AS col FROM groups').all() as {
    id: number
    col: string
  }[]
  for (const row of rows) {
    const eligible = JSON.parse(row.col) as { eventId: number; minutes: number }[]
    if (eligible.some((e) => e.eventId === eventId)) {
      db.prepare('UPDATE groups SET eligible_events = ? WHERE id = ?').run(
        JSON.stringify(eligible.filter((e) => e.eventId !== eventId)),
        row.id,
      )
    }
  }
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
        'INSERT INTO events (name, shared, capacity, active, color) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        e.name,
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
      'UPDATE events SET name = ?, shared = ?, capacity = ?, active = ?, color = ? WHERE id = ?',
    ).run(
      e.name,
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
      scrubEligibleEvent(db, id)
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
        `INSERT INTO groups (name, program_id, priority, days_of_week, start_time, eligible_events,
                             period_minutes, warmup_event_id, warmup_minutes, cooldown_event_id,
                             cooldown_minutes, assigned_coaches)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.name,
        c.programId,
        c.priority,
        JSON.stringify(c.daysOfWeek),
        c.startTime,
        JSON.stringify(c.eligibleEvents),
        c.periodMinutes,
        c.warmupEventId,
        c.warmupMinutes,
        c.cooldownEventId,
        c.cooldownMinutes,
        JSON.stringify(c.assignedCoaches),
      )
    reconcileSessions(db)
    const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(result.lastInsertRowid) as unknown as ClassRow
    res.status(201).json({ class: toClass(row) })
  })

  router.put('/classes/:id', (req, res) => {
    const id = idParam(req.params.id)
    const c = parseClass(req.body)
    requireRow(db.prepare('SELECT id FROM groups WHERE id = ?').get(id), 'class')
    requireProgram(c.programId)
    db.prepare(
      `UPDATE groups SET name = ?, program_id = ?, priority = ?, days_of_week = ?, start_time = ?,
                         eligible_events = ?, period_minutes = ?, warmup_event_id = ?,
                         warmup_minutes = ?, cooldown_event_id = ?, cooldown_minutes = ?,
                         assigned_coaches = ?
       WHERE id = ?`,
    ).run(
      c.name,
      c.programId,
      c.priority,
      JSON.stringify(c.daysOfWeek),
      c.startTime,
      JSON.stringify(c.eligibleEvents),
      c.periodMinutes,
      c.warmupEventId,
      c.warmupMinutes,
      c.cooldownEventId,
      c.cooldownMinutes,
      JSON.stringify(c.assignedCoaches),
      id,
    )
    // A schedule change can move the class between slots, so re-derive them.
    reconcileSessions(db)
    const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as unknown as ClassRow
    res.json({ class: toClass(row) })
  })

  router.delete('/classes/:id', (req, res) => {
    const id = idParam(req.params.id)
    requireRow(db.prepare('SELECT id FROM groups WHERE id = ?').get(id), 'class')
    // Placements (and their blocks) cascade; reconciliation then drops any
    // slot the class was the last member of.
    db.prepare('DELETE FROM groups WHERE id = ?').run(id)
    reconcileSessions(db)
    res.status(204).end()
  })

  return router
}
