import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import type { GymClass, GymEvent, Session } from '../../shared/types.ts'
import { appWithAdmin } from './helpers.ts'

let app: Express
let cookie: string

beforeEach(async () => {
  ;({ app, cookie } = await appWithAdmin())
})

describe('example gym', () => {
  it('reports not loaded on a fresh database', async () => {
    const res = await request(app).get('/api/example-gym').set('Cookie', cookie)
    expect(res.body).toEqual({ loaded: false })
  })

  it('seeds a coherent sample gym', async () => {
    await request(app).post('/api/example-gym').set('Cookie', cookie).expect(201)

    const events: GymEvent[] = (await request(app).get('/api/events').set('Cookie', cookie)).body.events
    const classes: GymClass[] = (await request(app).get('/api/classes').set('Cookie', cookie)).body.classes
    const sessions: Session[] = (await request(app).get('/api/sessions').set('Cookie', cookie)).body.sessions

    expect(events.length).toBeGreaterThanOrEqual(5)
    expect(classes.length).toBeGreaterThanOrEqual(3)
    expect(sessions).toHaveLength(1)
    expect(events.every((e) => e.isSample)).toBe(true)

    // Referential integrity: classes only require seeded events,
    // the session only contains seeded classes.
    const eventIds = new Set(events.map((e) => e.id))
    for (const cls of classes) {
      for (const req of cls.requiredEvents) {
        expect(eventIds.has(req.eventId)).toBe(true)
      }
      // Durations are multiples of the session's rotation length.
      for (const req of cls.requiredEvents) {
        expect(req.duration % sessions[0]!.rotationLength).toBe(0)
      }
    }
    const classIds = new Set(classes.map((c) => c.id))
    for (const gid of sessions[0]!.classes) {
      expect(classIds.has(gid)).toBe(true)
    }
  })

  it('refuses to double-seed', async () => {
    await request(app).post('/api/example-gym').set('Cookie', cookie).expect(201)
    await request(app).post('/api/example-gym').set('Cookie', cookie).expect(409)
  })

  it('removes all sample data in one call, leaving real data alone', async () => {
    const real = (
      await request(app).post('/api/events').set('Cookie', cookie).send({ name: 'My Real Beam' })
    ).body.event

    await request(app).post('/api/example-gym').set('Cookie', cookie).expect(201)
    await request(app).delete('/api/example-gym').set('Cookie', cookie).expect(204)

    const events = (await request(app).get('/api/events').set('Cookie', cookie)).body.events
    expect(events).toEqual([real])
    for (const path of ['/api/coaches', '/api/classes', '/api/sessions']) {
      const res = await request(app).get(path).set('Cookie', cookie)
      const list = Object.values(res.body)[0] as unknown[]
      expect(list).toHaveLength(0)
    }
    const loaded = await request(app).get('/api/example-gym').set('Cookie', cookie)
    expect(loaded.body).toEqual({ loaded: false })
  })
})
