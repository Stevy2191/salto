import { Router } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import type { AdjacencyPenalty, Settings } from '../../shared/types.ts'
import { ApiError, asObject, reqInt } from '../validate.ts'

function getValue(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value
}

function setValue(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value)
}

function getSettings(db: DatabaseSync): Settings {
  let adjacencyPenalties: AdjacencyPenalty[] = []
  const raw = getValue(db, 'adjacency_penalties')
  if (raw) {
    try {
      adjacencyPenalties = JSON.parse(raw) as AdjacencyPenalty[]
    } catch {
      // Corrupt value — treat as unset.
    }
  }
  return {
    // Anything but 'event' means class mode — including the legacy stored
    // value 'group' from before the groups → classes rename.
    coachMode: getValue(db, 'coach_mode') === 'event' ? 'event' : 'class',
    adjacencyPenalties,
  }
}

function parsePenalties(value: unknown): AdjacencyPenalty[] {
  if (!Array.isArray(value)) {
    throw new ApiError(400, 'adjacencyPenalties must be an array of event pairs')
  }
  return value.map((entry): AdjacencyPenalty => {
    const pair = asObject(entry)
    return {
      beforeEventId: reqInt(pair.beforeEventId, 'beforeEventId', 1, Number.MAX_SAFE_INTEGER),
      afterEventId: reqInt(pair.afterEventId, 'afterEventId', 1, Number.MAX_SAFE_INTEGER),
    }
  })
}

export function settingsRoutes(db: DatabaseSync): Router {
  const router = Router()

  router.get('/settings', (_req, res) => {
    res.json({ settings: getSettings(db) })
  })

  router.put('/settings', (req, res) => {
    const obj = asObject(req.body)
    if (obj.coachMode !== undefined) {
      if (obj.coachMode !== 'class' && obj.coachMode !== 'event') {
        throw new ApiError(400, "coachMode must be 'class' or 'event'")
      }
      setValue(db, 'coach_mode', obj.coachMode)
    }
    if (obj.adjacencyPenalties !== undefined) {
      setValue(db, 'adjacency_penalties', JSON.stringify(parsePenalties(obj.adjacencyPenalties)))
    }
    res.json({ settings: getSettings(db) })
  })

  return router
}
