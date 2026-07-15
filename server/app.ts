import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import { csrfProtect, LoginRateLimiter, requireAuth } from './auth.ts'
import { authRoutes } from './routes/auth.ts'
import { entityRoutes } from './routes/entities.ts'
import { scheduleRoutes } from './routes/schedule.ts'
import { settingsRoutes } from './routes/settings.ts'
import { exampleGymRoutes } from './routes/exampleGym.ts'
import { exportRoutes } from './routes/export.ts'
import { ApiError } from './validate.ts'

export interface AppOptions {
  loginLimiter?: LoginRateLimiter
}

export function createApp(db: DatabaseSync, options: AppOptions = {}): express.Express {
  const app = express()

  // One reverse-proxy hop (e.g. Nginx Proxy Manager) so X-Forwarded-* headers
  // are trusted for secure cookies and rate limiting.
  app.set('trust proxy', 1)

  app.use(express.json())
  app.use(csrfProtect)

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  app.use('/api', authRoutes(db, options.loginLimiter ?? new LoginRateLimiter()))

  // Everything else under /api requires a logged-in admin.
  const protectedApi = express.Router()
  protectedApi.use(entityRoutes(db))
  protectedApi.use(scheduleRoutes(db))
  protectedApi.use(settingsRoutes(db))
  protectedApi.use(exampleGymRoutes(db))
  protectedApi.use(exportRoutes(db))
  app.use('/api', requireAuth(db), protectedApi)

  // Static frontend + SPA fallback. dist/ is absent in dev/tests, where only
  // the API is exercised.
  const distDir = path.resolve(import.meta.dirname, '../dist')
  const hasDist = fs.existsSync(path.join(distDir, 'index.html'))
  if (hasDist) {
    app.use(express.static(distDir))
  }
  app.use((req, res) => {
    if (!hasDist || req.path.startsWith('/api/')) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.sendFile(path.join(distDir, 'index.html'))
  })

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err)
      return
    }
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    // Malformed JSON bodies surface here from express.json().
    if (err instanceof SyntaxError && 'status' in err && err.status === 400) {
      res.status(400).json({ error: 'invalid JSON body' })
      return
    }
    console.error(err)
    res.status(500).json({ error: 'internal server error' })
  })

  return app
}
