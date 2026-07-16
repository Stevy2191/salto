import { Router } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import type { EventBlock, Placement, Schedule } from '../../shared/types.ts'
import { PLAN_WEEKS } from '../../shared/types.ts'
import { SLOT_MINUTES, isSnapped, overlaps, parseTime } from '../../shared/slots.ts'
import { ApiError, asObject, idParam, reqBool, reqInt } from '../validate.ts'
import { withTransaction } from '../tx.ts'

// A session holds a 4-week rotation plan. Each week is one grid: columns
// (lanes) of class placements, each holding explicit event blocks. Storage
// keeps the pre-rename `groups`/`class_id` naming at the SQL layer only.

interface PlacementRow {
  id: number
  class_id: number
  column_index: number
  week: number
  start_min: number
  end_min: number
}

interface BlockRow {
  id: number
  placement_id: number
  event_id: number
  coach_id: number | null
  start_min: number
  end_min: number
  locked: number
}

const MAX_ID = Number.MAX_SAFE_INTEGER

/** One week of a session's grid. Week defaults to 1 for the single-grid views. */
export function loadSchedule(db: DatabaseSync, sessionId: number, week = 1): Schedule {
  const placements = db
    .prepare(
      'SELECT id, class_id, column_index, week, start_min, end_min FROM placements WHERE session_id = ? AND week = ? ORDER BY column_index, start_min',
    )
    .all(sessionId, week) as unknown as PlacementRow[]
  const blocks = db
    .prepare(
      `SELECT b.id, b.placement_id, b.event_id, b.coach_id, b.start_min, b.end_min, b.locked
       FROM event_blocks b JOIN placements p ON p.id = b.placement_id
       WHERE p.session_id = ? AND p.week = ? ORDER BY b.start_min`,
    )
    .all(sessionId, week) as unknown as BlockRow[]

  const byPlacement = new Map<number, EventBlock[]>()
  for (const b of blocks) {
    const list = byPlacement.get(b.placement_id) ?? []
    list.push({
      id: b.id,
      eventId: b.event_id,
      coachId: b.coach_id,
      startMin: b.start_min,
      endMin: b.end_min,
      locked: b.locked === 1,
    })
    byPlacement.set(b.placement_id, list)
  }

  return {
    placements: placements.map(
      (p): Placement => ({
        id: p.id,
        classId: p.class_id,
        columnIndex: p.column_index,
        week: p.week,
        startMin: p.start_min,
        endMin: p.end_min,
        blocks: byPlacement.get(p.id) ?? [],
      }),
    ),
  }
}

interface ParsedBlock {
  eventId: number
  coachId: number | null
  startMin: number
  endMin: number
  locked: boolean
}

interface ParsedPlacement {
  classId: number
  columnIndex: number
  startMin: number
  endMin: number
  blocks: ParsedBlock[]
}

/**
 * Validates one week's grid, not just field shapes: everything snaps to 5
 * minutes, class windows stay inside the session, placements in a column
 * never overlap, and blocks stay inside their class's window without
 * overlapping each other.
 */
function parseSchedule(
  body: unknown,
  session: { startMin: number; endMin: number; columnCount: number },
  className: (id: number) => string,
): ParsedPlacement[] {
  const obj = asObject(body)
  if (!Array.isArray(obj.placements)) throw new ApiError(400, 'placements must be an array')

  const placements = obj.placements.map((entry): ParsedPlacement => {
    const p = asObject(entry)
    const startMin = reqInt(p.startMin, 'placement.startMin', 0, 24 * 60)
    const endMin = reqInt(p.endMin, 'placement.endMin', 0, 24 * 60)
    const columnIndex = reqInt(p.columnIndex, 'placement.columnIndex', 0, session.columnCount - 1)
    const classId = reqInt(p.classId, 'placement.classId', 1, MAX_ID)
    if (!isSnapped(startMin) || !isSnapped(endMin)) {
      throw new ApiError(400, 'class times must land on 5-minute boundaries')
    }
    if (endMin <= startMin) {
      throw new ApiError(400, `${className(classId)}'s window must end after it starts`)
    }
    if (startMin < session.startMin || endMin > session.endMin) {
      throw new ApiError(400, `${className(classId)}'s window falls outside the session`)
    }

    const rawBlocks = p.blocks ?? []
    if (!Array.isArray(rawBlocks)) throw new ApiError(400, 'placement.blocks must be an array')
    const blocks = rawBlocks.map((raw): ParsedBlock => {
      const b = asObject(raw)
      const bStart = reqInt(b.startMin, 'block.startMin', 0, 24 * 60)
      const bEnd = reqInt(b.endMin, 'block.endMin', 0, 24 * 60)
      if (!isSnapped(bStart) || !isSnapped(bEnd)) {
        throw new ApiError(400, 'event blocks must land on 5-minute boundaries')
      }
      if (bEnd <= bStart) throw new ApiError(400, 'an event block must end after it starts')
      if (bStart < startMin || bEnd > endMin) {
        throw new ApiError(400, `an event block falls outside ${className(classId)}'s window`)
      }
      return {
        eventId: reqInt(b.eventId, 'block.eventId', 1, MAX_ID),
        coachId:
          b.coachId === null || b.coachId === undefined
            ? null
            : reqInt(b.coachId, 'block.coachId', 1, MAX_ID),
        startMin: bStart,
        endMin: bEnd,
        locked: b.locked === undefined ? false : reqBool(b.locked, 'block.locked'),
      }
    })

    const ordered = [...blocks].sort((a, b) => a.startMin - b.startMin)
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i]!.startMin < ordered[i - 1]!.endMin) {
        throw new ApiError(400, `${className(classId)} has two event blocks that overlap`)
      }
    }

    return { classId, columnIndex, startMin, endMin, blocks }
  })

  const byColumn = new Map<number, ParsedPlacement[]>()
  for (const p of placements) {
    byColumn.set(p.columnIndex, [...(byColumn.get(p.columnIndex) ?? []), p])
  }
  for (const [columnIndex, list] of byColumn) {
    const ordered = [...list].sort((a, b) => a.startMin - b.startMin)
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1]!
      const cur = ordered[i]!
      if (overlaps(prev.startMin, prev.endMin, cur.startMin, cur.endMin)) {
        throw new ApiError(
          400,
          `${className(prev.classId)} and ${className(cur.classId)} overlap in column ${columnIndex + 1} — a column holds one class at a time`,
        )
      }
    }
  }

  return placements
}

/** Which week the request is about (query ?week=N), defaulting to 1. */
function weekParam(raw: unknown): number {
  if (raw === undefined) return 1
  const week = Number(raw)
  if (!Number.isInteger(week) || week < 1 || week > PLAN_WEEKS) {
    throw new ApiError(400, `week must be between 1 and ${PLAN_WEEKS}`)
  }
  return week
}

export function scheduleRoutes(db: DatabaseSync): Router {
  const router = Router()

  const sessionOr404 = (id: number) => {
    const row = db
      .prepare('SELECT start_time, end_time, column_count FROM sessions WHERE id = ?')
      .get(id) as { start_time: string; end_time: string; column_count: number } | undefined
    if (!row) throw new ApiError(404, 'session not found')
    return {
      startMin: parseTime(row.start_time) ?? 0,
      endMin: parseTime(row.end_time) ?? 0,
      columnCount: row.column_count,
    }
  }

  router.get('/sessions/:id/schedule', (req, res) => {
    const sessionId = idParam(req.params.id)
    sessionOr404(sessionId)
    res.json({ schedule: loadSchedule(db, sessionId, weekParam(req.query.week)) })
  })

  /**
   * Set which classes attend. Every class runs the session's clock, so each
   * takes its own column, and every attending class gets a placement in all
   * PLAN_WEEKS weeks (blocks arrive from Generate or by hand). Classes
   * already attending keep their column and any painted work; dropped ones
   * lose all their placements.
   */
  router.put('/sessions/:id/classes', (req, res) => {
    const sessionId = idParam(req.params.id)
    const session = sessionOr404(sessionId)

    const obj = asObject(req.body)
    if (!Array.isArray(obj.classIds)) throw new ApiError(400, 'classIds must be an array')
    const wanted = obj.classIds.map((id) => reqInt(id, 'classIds', 1, MAX_ID))
    const names = new Map(
      (db.prepare('SELECT id, name FROM groups').all() as { id: number; name: string }[]).map(
        (c) => [c.id, c.name],
      ),
    )
    for (const id of wanted) {
      if (!names.has(id)) throw new ApiError(400, `class #${id} no longer exists`)
    }
    if (session.endMin - session.startMin < SLOT_MINUTES) {
      throw new ApiError(400, 'the session window has no time in it')
    }

    withTransaction(db, () => {
      const existing = db
        .prepare('SELECT DISTINCT class_id, column_index FROM placements WHERE session_id = ?')
        .all(sessionId) as { class_id: number; column_index: number }[]
      const keep = new Set(wanted)
      for (const row of existing) {
        if (!keep.has(row.class_id)) {
          db.prepare('DELETE FROM placements WHERE session_id = ? AND class_id = ?').run(
            sessionId,
            row.class_id,
          )
        }
      }
      const columnOf = new Map(existing.filter((r) => keep.has(r.class_id)).map((r) => [r.class_id, r.column_index]))
      const usedColumns = new Set(columnOf.values())
      const insert = db.prepare(
        'INSERT INTO placements (session_id, class_id, column_index, week, start_min, end_min) VALUES (?, ?, ?, ?, ?, ?)',
      )
      const haveWeeks = new Map<number, Set<number>>()
      for (const p of db
        .prepare('SELECT class_id, week FROM placements WHERE session_id = ?')
        .all(sessionId) as { class_id: number; week: number }[]) {
        haveWeeks.set(p.class_id, (haveWeeks.get(p.class_id) ?? new Set()).add(p.week))
      }

      let nextColumn = 0
      const takeColumn = () => {
        while (usedColumns.has(nextColumn)) nextColumn++
        usedColumns.add(nextColumn)
        return nextColumn
      }
      for (const classId of wanted) {
        const column = columnOf.get(classId) ?? takeColumn()
        const have = haveWeeks.get(classId) ?? new Set<number>()
        for (let week = 1; week <= PLAN_WEEKS; week++) {
          if (!have.has(week)) {
            insert.run(sessionId, classId, column, week, session.startMin, session.endMin)
          }
        }
      }

      const columnCount = wanted.length === 0 ? 0 : Math.max(...[...usedColumns]) + 1
      db.prepare('UPDATE sessions SET column_count = ? WHERE id = ?').run(columnCount, sessionId)
    })

    res.json({ schedule: loadSchedule(db, sessionId, 1) })
  })

  /**
   * Which weeks are locked against re-generation (a boolean per week), and
   * optionally the plan's coverage/collision warnings. `planWarnings` is only
   * touched when provided, so toggling a lock never clears the last
   * generation's flags.
   */
  router.put('/sessions/:id/week-locks', (req, res) => {
    const sessionId = idParam(req.params.id)
    if (!db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId)) {
      throw new ApiError(404, 'session not found')
    }
    const obj = asObject(req.body)
    if (!Array.isArray(obj.weekLocks) || obj.weekLocks.length !== PLAN_WEEKS) {
      throw new ApiError(400, `weekLocks must be ${PLAN_WEEKS} booleans`)
    }
    const locks = obj.weekLocks.map((v) => reqBool(v, 'weekLocks'))
    if (obj.planWarnings !== undefined) {
      if (!Array.isArray(obj.planWarnings) || obj.planWarnings.some((w) => typeof w !== 'string')) {
        throw new ApiError(400, 'planWarnings must be an array of strings')
      }
      db.prepare('UPDATE sessions SET week_locks = ?, plan_warnings = ? WHERE id = ?').run(
        JSON.stringify(locks),
        JSON.stringify(obj.planWarnings),
        sessionId,
      )
      res.json({ weekLocks: locks, planWarnings: obj.planWarnings })
      return
    }
    db.prepare('UPDATE sessions SET week_locks = ? WHERE id = ?').run(JSON.stringify(locks), sessionId)
    res.json({ weekLocks: locks })
  })

  // Full replace of one week: the grid saves its complete state for that week.
  router.put('/sessions/:id/schedule', (req, res) => {
    const sessionId = idParam(req.params.id)
    const session = sessionOr404(sessionId)
    const week = weekParam(req.query.week)
    const names = new Map(
      (db.prepare('SELECT id, name FROM groups').all() as { id: number; name: string }[]).map(
        (c) => [c.id, c.name],
      ),
    )
    const className = (id: number) => names.get(id) ?? `class #${id}`
    const placements = parseSchedule(req.body, session, className)

    try {
      withTransaction(db, () => {
        // Only this week's placements are replaced; the other weeks stand.
        db.prepare('DELETE FROM placements WHERE session_id = ? AND week = ?').run(sessionId, week)
        const insertPlacement = db.prepare(
          'INSERT INTO placements (session_id, class_id, column_index, week, start_min, end_min) VALUES (?, ?, ?, ?, ?, ?)',
        )
        const insertBlock = db.prepare(
          'INSERT INTO event_blocks (placement_id, event_id, coach_id, start_min, end_min, locked) VALUES (?, ?, ?, ?, ?, ?)',
        )
        for (const p of placements) {
          const placementId = Number(
            insertPlacement.run(sessionId, p.classId, p.columnIndex, week, p.startMin, p.endMin)
              .lastInsertRowid,
          )
          for (const b of p.blocks) {
            insertBlock.run(placementId, b.eventId, b.coachId, b.startMin, b.endMin, b.locked ? 1 : 0)
          }
        }
      })
    } catch (err) {
      if (err instanceof Error && err.message.includes('FOREIGN KEY')) {
        throw new ApiError(400, 'the schedule references a class, event, or coach that no longer exists')
      }
      throw err
    }
    res.json({ schedule: loadSchedule(db, sessionId, week) })
  })

  return router
}
