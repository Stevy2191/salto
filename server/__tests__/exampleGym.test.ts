import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import type { GymClass, GymEvent, Schedule, Session } from '../../shared/types.ts'
import { isIsoDate, todayIsoDate } from '../../shared/dates.ts'
import { isSnapped, overlaps, sessionWindow } from '../../shared/slots.ts'
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
    expect(sessions).toHaveLength(2)
    expect(events.every((e) => e.isSample)).toBe(true)

    // Sample events mix limited and unlimited capacities.
    expect(events.some((e) => e.capacity === null)).toBe(true)
    expect(events.some((e) => e.capacity !== null)).toBe(true)

    // Sessions sit on real, upcoming dates, listed chronologically.
    const today = todayIsoDate()
    expect(sessions.every((s) => isIsoDate(s.date) && s.date >= today)).toBe(true)
    expect([...sessions].sort((a, b) => a.date.localeCompare(b.date))).toEqual(sessions)

    // Referential integrity: classes only require seeded events, and every
    // required duration lands on the 5-minute axis.
    const eventIds = new Set(events.map((e) => e.id))
    for (const cls of classes) {
      for (const req of cls.requiredEvents) {
        expect(eventIds.has(req.eventId)).toBe(true)
        expect(isSnapped(req.duration)).toBe(true)
      }
    }

    // Every session's grid is coherent: placements name seeded classes,
    // sit inside the session window, snap to 5 minutes, and never overlap
    // within a column.
    const classIds = new Set(classes.map((c) => c.id))
    for (const session of sessions) {
      const { schedule } = (
        await request(app).get(`/api/sessions/${session.id}/schedule`).set('Cookie', cookie)
      ).body as { schedule: Schedule }
      const { startMin, endMin } = sessionWindow(session)
      expect(schedule.placements.length).toBeGreaterThan(0)
      for (const p of schedule.placements) {
        expect(classIds.has(p.classId)).toBe(true)
        expect(p.columnIndex).toBeLessThan(session.columnCount)
        expect(isSnapped(p.startMin) && isSnapped(p.endMin)).toBe(true)
        expect(p.startMin).toBeGreaterThanOrEqual(startMin)
        expect(p.endMin).toBeLessThanOrEqual(endMin)
        expect(p.endMin).toBeGreaterThan(p.startMin)
        // Blocks stay inside their class's own window.
        for (const b of p.blocks) {
          expect(b.startMin).toBeGreaterThanOrEqual(p.startMin)
          expect(b.endMin).toBeLessThanOrEqual(p.endMin)
          expect(eventIds.has(b.eventId)).toBe(true)
        }
      }
      for (let c = 0; c < session.columnCount; c++) {
        const lane = schedule.placements
          .filter((p) => p.columnIndex === c)
          .sort((a, b) => a.startMin - b.startMin)
        for (let i = 1; i < lane.length; i++) {
          expect(overlaps(lane[i - 1]!.startMin, lane[i - 1]!.endMin, lane[i]!.startMin, lane[i]!.endMin)).toBe(false)
        }
      }
    }
  })

  it('demonstrates the lane model: stacked classes, a full run, partial windows', async () => {
    await request(app).post('/api/example-gym').set('Cookie', cookie).expect(201)
    const sessions: Session[] = (await request(app).get('/api/sessions').set('Cookie', cookie)).body.sessions
    const classes: GymClass[] = (await request(app).get('/api/classes').set('Cookie', cookie)).body.classes
    const nameOf = new Map(classes.map((c) => [c.id, c.name]))

    const monday = sessions.find((s) => s.name.startsWith('Monday'))!
    const { schedule } = (
      await request(app).get(`/api/sessions/${monday.id}/schedule`).set('Cookie', cookie)
    ).body as { schedule: Schedule }
    const { startMin, endMin } = sessionWindow(monday)

    // A lane running several classes back to back, in order, touching but
    // never overlapping.
    const stacked = schedule.placements
      .filter((p) => p.columnIndex === 0)
      .sort((a, b) => a.startMin - b.startMin)
    expect(stacked.length).toBeGreaterThanOrEqual(3)
    expect(stacked.map((p) => nameOf.get(p.classId))).toEqual(['LV 1', 'LV 2', 'VYC 2'])
    for (let i = 1; i < stacked.length; i++) {
      expect(stacked[i]!.startMin).toBe(stacked[i - 1]!.endMin)
    }

    // A class running the whole session…
    expect(
      schedule.placements.some((p) => p.startMin === startMin && p.endMin === endMin),
    ).toBe(true)
    // …and classes taking only part of it, leaving genuine blank time.
    expect(schedule.placements.some((p) => p.endMin < endMin)).toBe(true)
    expect(schedule.placements.some((p) => p.startMin > startMin)).toBe(true)
    // Some work is already painted, and it is not a single event.
    const painted = schedule.placements.flatMap((p) => p.blocks)
    expect(painted.length).toBeGreaterThan(4)
    expect(new Set(painted.map((b) => b.eventId)).size).toBeGreaterThan(1)
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
