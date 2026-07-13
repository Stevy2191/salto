import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { createApp } from '../app.ts'
import { LoginRateLimiter, hashPassword, verifyPassword } from '../auth.ts'
import { openDb } from '../db.ts'

function makeApp(limiter?: LoginRateLimiter): Express {
  return createApp(openDb(':memory:'), { loginLimiter: limiter })
}

async function setupAdmin(app: Express): Promise<string> {
  const res = await request(app)
    .post('/api/setup')
    .send({ username: 'admin', password: 'correct-horse' })
  expect(res.status).toBe(201)
  const cookie = res.headers['set-cookie']?.[0]
  expect(cookie).toContain('salto_session=')
  return cookie!.split(';')[0]!
}

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', () => {
    const hash = hashPassword('s3cret-password')
    expect(verifyPassword('s3cret-password', hash)).toBe(true)
    expect(verifyPassword('wrong-password', hash)).toBe(false)
  })

  it('produces unique salts', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'))
  })
})

describe('first-run setup', () => {
  let app: Express
  beforeEach(() => {
    app = makeApp()
  })

  it('reports setupNeeded until an admin exists', async () => {
    const before = await request(app).get('/api/me')
    expect(before.body).toEqual({ setupNeeded: true, user: null })

    const cookie = await setupAdmin(app)

    const after = await request(app).get('/api/me').set('Cookie', cookie)
    expect(after.body).toEqual({
      setupNeeded: false,
      user: { id: 1, username: 'admin' },
    })
  })

  it('logs the admin in immediately after setup', async () => {
    const cookie = await setupAdmin(app)
    const me = await request(app).get('/api/me').set('Cookie', cookie)
    expect(me.body.user).not.toBeNull()
  })

  it('refuses a second setup', async () => {
    await setupAdmin(app)
    const res = await request(app)
      .post('/api/setup')
      .send({ username: 'intruder', password: 'longenough' })
    expect(res.status).toBe(409)
  })

  it('rejects short passwords', async () => {
    const res = await request(app)
      .post('/api/setup')
      .send({ username: 'admin', password: 'short' })
    expect(res.status).toBe(400)
  })
})

describe('login and logout', () => {
  let app: Express
  beforeEach(async () => {
    app = makeApp()
    await setupAdmin(app)
  })

  it('logs in with correct credentials', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ username: 'admin', password: 'correct-horse' })
    expect(res.status).toBe(200)
    expect(res.body.user.username).toBe('admin')
    expect(res.headers['set-cookie']?.[0]).toContain('salto_session=')
  })

  it('rejects a wrong password', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ username: 'admin', password: 'wrong-password' })
    expect(res.status).toBe(401)
  })

  it('rejects an unknown username', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ username: 'nobody', password: 'whatever-long' })
    expect(res.status).toBe(401)
  })

  it('logout invalidates the session', async () => {
    const login = await request(app)
      .post('/api/login')
      .send({ username: 'admin', password: 'correct-horse' })
    const cookie = login.headers['set-cookie']![0]!.split(';')[0]!

    await request(app).post('/api/logout').set('Cookie', cookie).expect(204)

    const me = await request(app).get('/api/me').set('Cookie', cookie)
    expect(me.body.user).toBeNull()
  })
})

describe('login rate limiting', () => {
  it('locks out after too many failures', async () => {
    const app = makeApp(new LoginRateLimiter(2, 60_000))
    await setupAdmin(app)

    const bad = { username: 'admin', password: 'wrong-password' }
    await request(app).post('/api/login').send(bad).expect(401)
    await request(app).post('/api/login').send(bad).expect(401)
    await request(app).post('/api/login').send(bad).expect(429)

    // Even correct credentials are rejected while locked out.
    await request(app)
      .post('/api/login')
      .send({ username: 'admin', password: 'correct-horse' })
      .expect(429)
  })
})

describe('CSRF protection', () => {
  it('rejects mutating requests from a foreign origin', async () => {
    const app = makeApp()
    const res = await request(app)
      .post('/api/setup')
      .set('Origin', 'https://evil.example.com')
      .send({ username: 'admin', password: 'correct-horse' })
    expect(res.status).toBe(403)
  })

  it('accepts mutating requests from our own origin', async () => {
    const app = makeApp()
    const res = await request(app)
      .post('/api/setup')
      .set('Origin', 'http://127.0.0.1')
      .set('Host', '127.0.0.1')
      .send({ username: 'admin', password: 'correct-horse' })
    expect(res.status).toBe(201)
  })
})
