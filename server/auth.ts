import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { User } from '../shared/types.ts'

const SESSION_COOKIE = 'salto_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

// Password hashing uses Node's built-in scrypt (a memory-hard KDF in the
// same class as bcrypt/argon2) to avoid native-module builds in the
// Alpine Docker image. Stored as "salthex:keyhex".
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  const key = crypto.scryptSync(password, salt, 64)
  return `${salt.toString('hex')}:${key.toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, keyHex] = stored.split(':')
  if (!saltHex || !keyHex) return false
  const key = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64)
  const expected = Buffer.from(keyHex, 'hex')
  return key.length === expected.length && crypto.timingSafeEqual(key, expected)
}

// Sessions are opaque random tokens; only their SHA-256 is stored, so a
// leaked database cannot be replayed into live sessions and no signing
// secret is needed.
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function createSession(db: DatabaseSync, userId: number): string {
  const token = crypto.randomBytes(32).toString('hex')
  db.prepare(
    'INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
  ).run(hashToken(token), userId, Date.now() + SESSION_TTL_MS)
  return token
}

export function destroySession(db: DatabaseSync, token: string): void {
  db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(token))
}

function getCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim())
    }
  }
  return null
}

export function sessionToken(req: Request): string | null {
  return getCookie(req, SESSION_COOKIE)
}

export function userForRequest(db: DatabaseSync, req: Request): User | null {
  const token = sessionToken(req)
  if (!token) return null
  const row = db
    .prepare(
      `SELECT u.id, u.username, s.expires_at AS expiresAt
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(hashToken(token)) as { id: number; username: string; expiresAt: number } | undefined
  if (!row) return null
  if (row.expiresAt < Date.now()) {
    destroySession(db, token)
    return null
  }
  return { id: row.id, username: row.username }
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_TTL_MS,
    path: '/',
  })
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' })
}

export function requireAuth(db: DatabaseSync): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = userForRequest(db, req)
    if (!user) {
      res.status(401).json({ error: 'authentication required' })
      return
    }
    res.locals.user = user
    next()
  }
}

// CSRF protection: session cookies are SameSite=Lax, and on top of that any
// mutating request that carries a browser Origin header must originate from
// the host we are serving. Requests without Origin (curl, tests) pass — they
// don't carry ambient browser credentials.
export function csrfProtect(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next()
    return
  }
  const origin = req.headers.origin
  if (origin) {
    let originHost: string
    try {
      originHost = new URL(origin).host
    } catch {
      res.status(403).json({ error: 'invalid origin' })
      return
    }
    if (originHost !== req.headers.host) {
      res.status(403).json({ error: 'cross-origin request rejected' })
      return
    }
  }
  next()
}

interface RateLimitEntry {
  failures: number
  windowStart: number
}

/** In-memory failed-login limiter, keyed by client IP. */
export class LoginRateLimiter {
  private entries = new Map<string, RateLimitEntry>()
  private maxFailures: number
  private windowMs: number

  constructor(maxFailures = 10, windowMs = 15 * 60 * 1000) {
    this.maxFailures = maxFailures
    this.windowMs = windowMs
  }

  allowed(key: string): boolean {
    const entry = this.entries.get(key)
    if (!entry) return true
    if (Date.now() - entry.windowStart > this.windowMs) {
      this.entries.delete(key)
      return true
    }
    return entry.failures < this.maxFailures
  }

  recordFailure(key: string): void {
    const entry = this.entries.get(key)
    if (!entry || Date.now() - entry.windowStart > this.windowMs) {
      this.entries.set(key, { failures: 1, windowStart: Date.now() })
      return
    }
    entry.failures += 1
  }

  reset(key: string): void {
    this.entries.delete(key)
  }
}
