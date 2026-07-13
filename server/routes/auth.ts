import { Router } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import type { MeResponse } from '../../shared/types.ts'
import {
  clearSessionCookie,
  createSession,
  destroySession,
  hashPassword,
  sessionToken,
  setSessionCookie,
  userForRequest,
  verifyPassword,
  type LoginRateLimiter,
} from '../auth.ts'

function userCount(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
  return row.n
}

function parseCredentials(body: unknown): { username: string; password: string } | null {
  if (typeof body !== 'object' || body === null) return null
  const { username, password } = body as Record<string, unknown>
  if (typeof username !== 'string' || typeof password !== 'string') return null
  const trimmed = username.trim()
  if (trimmed.length === 0 || trimmed.length > 64) return null
  return { username: trimmed, password }
}

export function authRoutes(db: DatabaseSync, limiter: LoginRateLimiter): Router {
  const router = Router()

  router.get('/me', (req, res) => {
    const response: MeResponse = {
      setupNeeded: userCount(db) === 0,
      user: userForRequest(db, req),
    }
    res.json(response)
  })

  // First-run admin account creation. Only ever works on an empty users table.
  router.post('/setup', (req, res) => {
    if (userCount(db) > 0) {
      res.status(409).json({ error: 'setup already completed' })
      return
    }
    const creds = parseCredentials(req.body)
    if (!creds) {
      res.status(400).json({ error: 'username and password are required' })
      return
    }
    if (creds.password.length < 8) {
      res.status(400).json({ error: 'password must be at least 8 characters' })
      return
    }
    const result = db
      .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run(creds.username, hashPassword(creds.password))
    const userId = Number(result.lastInsertRowid)
    setSessionCookie(req, res, createSession(db, userId))
    res.status(201).json({ user: { id: userId, username: creds.username } })
  })

  router.post('/login', (req, res) => {
    const key = req.ip ?? 'unknown'
    if (!limiter.allowed(key)) {
      res.status(429).json({ error: 'too many failed attempts; try again later' })
      return
    }
    const creds = parseCredentials(req.body)
    if (!creds) {
      res.status(400).json({ error: 'username and password are required' })
      return
    }
    const user = db
      .prepare('SELECT id, username, password_hash AS passwordHash FROM users WHERE username = ?')
      .get(creds.username) as { id: number; username: string; passwordHash: string } | undefined
    if (!user || !verifyPassword(creds.password, user.passwordHash)) {
      limiter.recordFailure(key)
      res.status(401).json({ error: 'invalid username or password' })
      return
    }
    limiter.reset(key)
    setSessionCookie(req, res, createSession(db, user.id))
    res.json({ user: { id: user.id, username: user.username } })
  })

  router.post('/logout', (req, res) => {
    const token = sessionToken(req)
    if (token) destroySession(db, token)
    clearSessionCookie(res)
    res.status(204).end()
  })

  return router
}
