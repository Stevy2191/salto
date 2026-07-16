import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import type { GymClass, GymEvent, Program, Schedule, Session } from '../../shared/types.ts'
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

    // Sample events mix shared and exclusive, and every duration lands on the
    // 5-minute axis.
    expect(events.some((e) => e.shared)).toBe(true)
    expect(events.some((e) => !e.shared)).toBe(true)
    expect(events.every((e) => isSnapped(e.duration) && e.duration > 0)).toBe(true)

    // Sessions are auto-derived weekly slots — the Monday and Wednesday 16:00
    // slots the classes' schedules imply — labelled by day and time.
    expect(sessions.map((s) => s.dayOfWeek).sort()).toEqual([1, 3])
    expect(sessions.every((s) => s.startTime === '16:00')).toBe(true)
    expect(sessions.map((s) => s.name).sort()).toEqual(['Monday 4:00 PM', 'Wednesday 4:00 PM'])

    // Referential integrity: classes are only eligible for seeded events, and
    // their warm-up/cool-down anchors point at seeded events too.
    const eventIds = new Set(events.map((e) => e.id))
    for (const cls of classes) {
      for (const id of cls.eligibleEventIds) expect(eventIds.has(id)).toBe(true)
      if (cls.warmupEventId !== null) expect(eventIds.has(cls.warmupEventId)).toBe(true)
      if (cls.cooldownEventId !== null) expect(eventIds.has(cls.cooldownEventId)).toBe(true)
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

  it('demonstrates the whole model: programs, anchors, and a contended event', async () => {
    await request(app).post('/api/example-gym').set('Cookie', cookie).expect(201)
    const programs: Program[] = (await request(app).get('/api/programs').set('Cookie', cookie)).body
      .programs
    const classes: GymClass[] = (await request(app).get('/api/classes').set('Cookie', cookie)).body
      .classes
    const events: GymEvent[] = (await request(app).get('/api/events').set('Cookie', cookie)).body
      .events

    // More than one program, each with a clock.
    expect(programs.length).toBeGreaterThanOrEqual(2)
    expect(programs.every((p) => p.defaultStartTime && p.defaultEndTime)).toBe(true)

    // Every class belongs to one, and every program has classes.
    expect(classes.every((c) => c.programId !== null)).toBe(true)
    for (const program of programs) {
      expect(classes.some((c) => c.programId === program.id)).toBe(true)
    }

    // Warm-ups and cool-downs are anchored, with lengths.
    expect(classes.every((c) => c.warmupEventId !== null && c.warmupMinutes > 0)).toBe(true)
    expect(classes.every((c) => c.cooldownEventId !== null && c.cooldownMinutes > 0)).toBe(true)

    // A class's eligible list can hold more events than fit one period — the
    // reason coverage is spread across four weeks. Middle time is the period
    // minus its warm-up and cool-down.
    const byId = new Map(events.map((e) => [e.id, e]))
    expect(
      classes.some((c) => {
        const middle = c.periodMinutes - c.warmupMinutes - c.cooldownMinutes
        const fit = c.eligibleEventIds.reduce((sum, id) => sum + (byId.get(id)?.duration ?? 0), 0)
        return fit > middle
      }),
    ).toBe(true)

    // A one-at-a-time apparatus that classes from different programs are all
    // eligible for — the contention the generator exists to resolve.
    const trak = events.find((e) => e.name === 'Tumble Trak')!
    expect(trak.shared).toBe(false)
    const wantTrak = classes.filter((c) => c.eligibleEventIds.includes(trak.id))
    expect(wantTrak.length).toBeGreaterThanOrEqual(3)
    expect(new Set(wantTrak.map((c) => c.programId)).size).toBeGreaterThan(1)
  })

  it('arrives with classes gathered and nothing painted — Generate is the demo', async () => {
    await request(app).post('/api/example-gym').set('Cookie', cookie).expect(201)
    const sessions: Session[] = (await request(app).get('/api/sessions').set('Cookie', cookie)).body
      .sessions
    const monday = sessions.find((s) => s.name.startsWith('Monday'))!

    // Each class runs the same clock, so each has its own lane; every week of
    // the plan carries the same classes, ungenerated.
    for (let week = 1; week <= 4; week++) {
      const { schedule } = (
        await request(app)
          .get(`/api/sessions/${monday.id}/schedule?week=${week}`)
          .set('Cookie', cookie)
      ).body as { schedule: Schedule }
      expect(schedule.placements.length).toBe(monday.columnCount)
      expect(schedule.placements.length).toBeGreaterThan(0)
      expect(schedule.placements.every((p) => p.endMin > p.startMin)).toBe(true)
      // Nothing is painted: the point is to press Generate.
      expect(schedule.placements.flatMap((p) => p.blocks)).toEqual([])
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
