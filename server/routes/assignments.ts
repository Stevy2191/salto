import { Router } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import type { Assignment } from '../../shared/types.ts'
import { slotCount } from '../../shared/slots.ts'
import { ApiError, asObject, idParam, reqBool, reqInt } from '../validate.ts'
import { withTransaction } from '../tx.ts'

interface AssignmentRow {
  slot_index: number
  event_id: number
  group_id: number
  coach_id: number | null
  locked: number
}

// Storage keeps the pre-rename `group_id` column name; the API says classId.
const toAssignment = (r: AssignmentRow): Assignment => ({
  slotIndex: r.slot_index,
  eventId: r.event_id,
  classId: r.group_id,
  coachId: r.coach_id,
  locked: r.locked === 1,
})

function parseAssignments(body: unknown, maxSlot: number): Assignment[] {
  const obj = asObject(body)
  if (!Array.isArray(obj.assignments)) {
    throw new ApiError(400, 'assignments must be an array')
  }
  const seen = new Set<string>()
  return obj.assignments.map((entry): Assignment => {
    const a = asObject(entry)
    const assignment: Assignment = {
      slotIndex: reqInt(a.slotIndex, 'slotIndex', 0, maxSlot - 1),
      eventId: reqInt(a.eventId, 'eventId', 1, Number.MAX_SAFE_INTEGER),
      classId: reqInt(a.classId, 'classId', 1, Number.MAX_SAFE_INTEGER),
      coachId:
        a.coachId === null || a.coachId === undefined
          ? null
          : reqInt(a.coachId, 'coachId', 1, Number.MAX_SAFE_INTEGER),
      locked: a.locked === undefined ? false : reqBool(a.locked, 'locked'),
    }
    const key = `${assignment.slotIndex}:${assignment.eventId}:${assignment.classId}`
    if (seen.has(key)) {
      throw new ApiError(400, 'duplicate assignment for the same slot, event, and class')
    }
    seen.add(key)
    return assignment
  })
}

export function assignmentRoutes(db: DatabaseSync): Router {
  const router = Router()

  router.get('/sessions/:id/assignments', (req, res) => {
    const sessionId = idParam(req.params.id)
    if (!db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId)) {
      throw new ApiError(404, 'session not found')
    }
    const rows = db
      .prepare('SELECT slot_index, event_id, group_id, coach_id, locked FROM assignments WHERE session_id = ? ORDER BY slot_index, event_id, group_id')
      .all(sessionId) as unknown as AssignmentRow[]
    res.json({ assignments: rows.map(toAssignment) })
  })

  // Full replace: the grid always saves its complete state for the session.
  router.put('/sessions/:id/assignments', (req, res) => {
    const sessionId = idParam(req.params.id)
    const session = db
      .prepare('SELECT start_time AS startTime, end_time AS endTime, rotation_length AS rotationLength FROM sessions WHERE id = ?')
      .get(sessionId) as { startTime: string; endTime: string; rotationLength: number } | undefined
    if (!session) throw new ApiError(404, 'session not found')

    const slots = slotCount(session)
    const assignments = parseAssignments(req.body, slots)

    try {
      withTransaction(db, () => {
        db.prepare('DELETE FROM assignments WHERE session_id = ?').run(sessionId)
        const insert = db.prepare(
          'INSERT INTO assignments (session_id, slot_index, event_id, group_id, coach_id, locked) VALUES (?, ?, ?, ?, ?, ?)',
        )
        for (const a of assignments) {
          insert.run(sessionId, a.slotIndex, a.eventId, a.classId, a.coachId, a.locked ? 1 : 0)
        }
      })
    } catch (err) {
      // Foreign keys catch references to deleted events/classes/coaches.
      if (err instanceof Error && err.message.includes('FOREIGN KEY')) {
        throw new ApiError(400, 'assignment references an event, class, or coach that no longer exists')
      }
      throw err
    }
    res.json({ assignments })
  })

  return router
}
