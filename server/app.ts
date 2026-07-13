import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import type { DatabaseSync } from 'node:sqlite'
import { csrfProtect, LoginRateLimiter } from './auth.ts'
import { authRoutes } from './routes/auth.ts'

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

  return app
}
