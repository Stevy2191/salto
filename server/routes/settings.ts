import { Router } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import type { Settings } from '../../shared/types.ts'
import { ApiError, asObject } from '../validate.ts'

function getSettings(db: DatabaseSync): Settings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'coach_mode'").get() as
    | { value: string }
    | undefined
  return { coachMode: row?.value === 'event' ? 'event' : 'group' }
}

export function settingsRoutes(db: DatabaseSync): Router {
  const router = Router()

  router.get('/settings', (_req, res) => {
    res.json({ settings: getSettings(db) })
  })

  router.put('/settings', (req, res) => {
    const obj = asObject(req.body)
    if (obj.coachMode !== 'group' && obj.coachMode !== 'event') {
      throw new ApiError(400, "coachMode must be 'group' or 'event'")
    }
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('coach_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(obj.coachMode)
    res.json({ settings: getSettings(db) })
  })

  return router
}
