import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { appWithAdmin } from './helpers.ts'

let app: Express
let cookie: string

beforeEach(async () => {
  ;({ app, cookie } = await appWithAdmin())
})

describe('auth gating', () => {
  it('rejects CRUD requests without a session', async () => {
    await request(app).get('/api/events').expect(401)
    await request(app).post('/api/classes').send({ name: 'X' }).expect(401)
  })
})

describe('events CRUD', () => {
  it('creates, lists, updates, and deletes an event', async () => {
    const created = await request(app)
      .post('/api/events')
      .set('Cookie', cookie)
      .send({ name: 'Vault', capacity: 1 })
      .expect(201)
    expect(created.body.event).toMatchObject({ name: 'Vault', capacity: 1, active: true })
    const id = created.body.event.id

    const list = await request(app).get('/api/events').set('Cookie', cookie)
    expect(list.body.events).toHaveLength(1)

    const updated = await request(app)
      .put(`/api/events/${id}`)
      .set('Cookie', cookie)
      .send({ name: 'Vault', capacity: 2, active: false })
      .expect(200)
    expect(updated.body.event).toMatchObject({ capacity: 2, active: false })

    await request(app).delete(`/api/events/${id}`).set('Cookie', cookie).expect(204)
    const after = await request(app).get('/api/events').set('Cookie', cookie)
    expect(after.body.events).toHaveLength(0)
  })

  it('auto-assigns distinct palette colors to new events', async () => {
    const first = (
      await request(app).post('/api/events').set('Cookie', cookie).send({ name: 'Vault' })
    ).body.event
    const second = (
      await request(app).post('/api/events').set('Cookie', cookie).send({ name: 'Beam' })
    ).body.event
    expect(first.color).toMatch(/^#[0-9A-F]{6}$/)
    expect(second.color).toMatch(/^#[0-9A-F]{6}$/)
    expect(first.color).not.toBe(second.color)
  })

  it('accepts a custom color and normalizes its case', async () => {
    const res = await request(app)
      .post('/api/events')
      .set('Cookie', cookie)
      .send({ name: 'Pit', color: '#a1b2c3' })
      .expect(201)
    expect(res.body.event.color).toBe('#A1B2C3')
  })

  it('rejects malformed colors', async () => {
    for (const color of ['#fff', 'red', '4E79A7', '#12345G']) {
      await request(app)
        .post('/api/events')
        .set('Cookie', cookie)
        .send({ name: 'Bad', color })
        .expect(400)
    }
  })

  it('keeps the existing color when an update omits it', async () => {
    const created = (
      await request(app)
        .post('/api/events')
        .set('Cookie', cookie)
        .send({ name: 'Floor', color: '#59A14F' })
    ).body.event
    const updated = await request(app)
      .put(`/api/events/${created.id}`)
      .set('Cookie', cookie)
      .send({ name: 'Floor Exercise' })
      .expect(200)
    expect(updated.body.event.color).toBe('#59A14F')
  })

  it('treats a missing or null capacity as no limit', async () => {
    const created = await request(app)
      .post('/api/events')
      .set('Cookie', cookie)
      .send({ name: 'Open Gym' })
      .expect(201)
    expect(created.body.event.capacity).toBeNull()
    const id = created.body.event.id

    const limited = await request(app)
      .put(`/api/events/${id}`)
      .set('Cookie', cookie)
      .send({ name: 'Open Gym', capacity: 3 })
      .expect(200)
    expect(limited.body.event.capacity).toBe(3)

    const cleared = await request(app)
      .put(`/api/events/${id}`)
      .set('Cookie', cookie)
      .send({ name: 'Open Gym', capacity: null })
      .expect(200)
    expect(cleared.body.event.capacity).toBeNull()
  })

  it('validates capacity and name', async () => {
    await request(app).post('/api/events').set('Cookie', cookie).send({ name: '' }).expect(400)
    await request(app)
      .post('/api/events')
      .set('Cookie', cookie)
      .send({ name: 'Vault', capacity: 0 })
      .expect(400)
  })

  it('404s on a missing event', async () => {
    await request(app)
      .put('/api/events/999')
      .set('Cookie', cookie)
      .send({ name: 'X' })
      .expect(404)
  })

  it('deleting an event scrubs it from coach specialties and class requirements', async () => {
    const event = (
      await request(app).post('/api/events').set('Cookie', cookie).send({ name: 'Beam' })
    ).body.event
    const coach = (
      await request(app)
        .post('/api/coaches')
        .set('Cookie', cookie)
        .send({ name: 'Riley Cho', specialties: [event.id] })
    ).body.coach
    const cls = (
      await request(app)
        .post('/api/classes')
        .set('Cookie', cookie)
        .send({ name: 'Level 3', requiredEvents: [{ eventId: event.id, duration: 30 }] })
    ).body.class

    await request(app).delete(`/api/events/${event.id}`).set('Cookie', cookie).expect(204)

    const coaches = await request(app).get('/api/coaches').set('Cookie', cookie)
    expect(coaches.body.coaches.find((c: { id: number }) => c.id === coach.id).specialties).toEqual([])
    const classes = await request(app).get('/api/classes').set('Cookie', cookie)
    expect(classes.body.classes.find((c: { id: number }) => c.id === cls.id).requiredEvents).toEqual([])
  })
})

describe('coaches CRUD', () => {
  it('round-trips specialties and availability', async () => {
    const created = await request(app)
      .post('/api/coaches')
      .set('Cookie', cookie)
      .send({ name: 'Dana Marsh', specialties: [1, 2], availability: [1, 3, 5] })
      .expect(201)
    expect(created.body.coach).toMatchObject({
      name: 'Dana Marsh',
      specialties: [1, 2],
      availability: [1, 3, 5],
    })
  })

  it('rejects availability days outside 0..6', async () => {
    await request(app)
      .post('/api/coaches')
      .set('Cookie', cookie)
      .send({ name: 'X', availability: [7] })
      .expect(400)
  })

  it('deleting a coach scrubs class assignments', async () => {
    const coach = (
      await request(app).post('/api/coaches').set('Cookie', cookie).send({ name: 'Sam Ortiz' })
    ).body.coach
    const cls = (
      await request(app)
        .post('/api/classes')
        .set('Cookie', cookie)
        .send({ name: 'Boys Team', assignedCoaches: [coach.id] })
    ).body.class

    await request(app).delete(`/api/coaches/${coach.id}`).set('Cookie', cookie).expect(204)
    const classes = await request(app).get('/api/classes').set('Cookie', cookie)
    expect(classes.body.classes.find((c: { id: number }) => c.id === cls.id).assignedCoaches).toEqual([])
  })
})

describe('classes CRUD', () => {
  it('stores required events with durations', async () => {
    const created = await request(app)
      .post('/api/classes')
      .set('Cookie', cookie)
      .send({
        name: 'Xcel Silver',
        priority: 2,
        requiredEvents: [
          { eventId: 1, duration: 30 },
          { eventId: 2, duration: 15 },
        ],
      })
      .expect(201)
    expect(created.body.class.requiredEvents).toHaveLength(2)
    expect(created.body.class.priority).toBe(2)
  })

  it('rejects malformed required events', async () => {
    await request(app)
      .post('/api/classes')
      .set('Cookie', cookie)
      .send({ name: 'X', requiredEvents: [{ eventId: 1 }] })
      .expect(400)
  })

  it('rejects required-event durations that are not multiples of 5', async () => {
    await request(app)
      .post('/api/classes')
      .set('Cookie', cookie)
      .send({ name: 'X', requiredEvents: [{ eventId: 1, duration: 22 }] })
      .expect(400)
  })

  it('deleting a class removes its placements from every session', async () => {
    const cls = (
      await request(app).post('/api/classes').set('Cookie', cookie).send({ name: 'L3' })
    ).body.class
    const session = (
      await request(app)
        .post('/api/sessions')
        .set('Cookie', cookie)
        .send({ date: '2026-03-02', startTime: '16:00', endTime: '18:00', classes: [cls.id] })
    ).body.session

    await request(app).delete(`/api/classes/${cls.id}`).set('Cookie', cookie).expect(204)
    const { schedule } = (
      await request(app).get(`/api/sessions/${session.id}/schedule`).set('Cookie', cookie)
    ).body
    expect(schedule.placements).toEqual([])
    // The lane itself survives — the column is a place, not the class.
    const after = await request(app).get(`/api/sessions/${session.id}`).set('Cookie', cookie)
    expect(after.body.session.columnCount).toBe(1)
  })
})

describe('sessions CRUD', () => {
  it('creates a session with defaults', async () => {
    const created = await request(app)
      .post('/api/sessions')
      .set('Cookie', cookie)
      .send({ date: '2026-03-02', startTime: '16:00', endTime: '18:30' })
      .expect(201)
    expect(created.body.session).toMatchObject({
      date: '2026-03-02',
      startTime: '16:00',
      endTime: '18:30',
      columnCount: 0,
    })
  })

  it('seeds a column per class when created with classes', async () => {
    const a = (await request(app).post('/api/classes').set('Cookie', cookie).send({ name: 'LV 1' }))
      .body.class.id
    const b = (await request(app).post('/api/classes').set('Cookie', cookie).send({ name: 'LV 2' }))
      .body.class.id
    const session = (
      await request(app)
        .post('/api/sessions')
        .set('Cookie', cookie)
        .send({ date: '2026-03-02', startTime: '16:00', endTime: '18:00', classes: [a, b] })
        .expect(201)
    ).body.session
    expect(session.columnCount).toBe(2)

    const { schedule } = (
      await request(app).get(`/api/sessions/${session.id}/schedule`).set('Cookie', cookie)
    ).body
    // Each class gets its own lane, running the whole window — what a fresh
    // session used to mean before columns existed.
    expect(schedule.placements).toMatchObject([
      { classId: a, columnIndex: 0, startMin: 960, endMin: 1080, blocks: [] },
      { classId: b, columnIndex: 1, startMin: 960, endMin: 1080, blocks: [] },
    ])
  })

  it('rejects a missing or unreal date', async () => {
    for (const date of [undefined, '', 'Monday', '2026-3-2', '2026-02-31']) {
      await request(app)
        .post('/api/sessions')
        .set('Cookie', cookie)
        .send({ date, startTime: '16:00', endTime: '18:30' })
        .expect(400)
    }
  })

  it('lists sessions chronologically, not by creation order', async () => {
    const create = (date: string, startTime: string) =>
      request(app)
        .post('/api/sessions')
        .set('Cookie', cookie)
        .send({ date, startTime, endTime: '20:00' })
        .expect(201)
    // Deliberately out of order, including two on the same day.
    await create('2026-03-09', '16:00')
    await create('2026-03-02', '17:00')
    await create('2026-03-02', '09:00')

    const listed = (await request(app).get('/api/sessions').set('Cookie', cookie)).body.sessions
    expect(listed.map((s: { date: string; startTime: string }) => [s.date, s.startTime])).toEqual([
      ['2026-03-02', '09:00'],
      ['2026-03-02', '17:00'],
      ['2026-03-09', '16:00'],
    ])
  })

  it('rejects a session window off the 5-minute axis', async () => {
    await request(app)
      .post('/api/sessions')
      .set('Cookie', cookie)
      .send({ date: '2026-03-03', startTime: '17:02', endTime: '19:00' })
      .expect(400)
  })

  it('refuses to shrink a session window past its class placements', async () => {
    const classId = (
      await request(app).post('/api/classes').set('Cookie', cookie).send({ name: 'L3' })
    ).body.class.id
    const session = (
      await request(app)
        .post('/api/sessions')
        .set('Cookie', cookie)
        .send({ date: '2026-03-02', startTime: '16:00', endTime: '20:00', classes: [classId] })
    ).body.session

    const res = await request(app)
      .put(`/api/sessions/${session.id}`)
      .set('Cookie', cookie)
      .send({ date: '2026-03-02', startTime: '16:00', endTime: '18:00' })
      .expect(400)
    expect(res.body.error).toMatch(/outside the new session window/)

    // Widening is fine — nothing falls outside.
    await request(app)
      .put(`/api/sessions/${session.id}`)
      .set('Cookie', cookie)
      .send({ date: '2026-03-02', startTime: '15:00', endTime: '21:00' })
      .expect(200)
  })

  it('stores day-of outages separately from session edits', async () => {
    const session = (
      await request(app)
        .post('/api/sessions')
        .set('Cookie', cookie)
        .send({ date: '2026-03-02', startTime: '16:00', endTime: '18:00' })
    ).body.session
    expect(session.absentCoaches).toEqual([])
    expect(session.unavailableEvents).toEqual([])

    const updated = await request(app)
      .put(`/api/sessions/${session.id}/outages`)
      .set('Cookie', cookie)
      .send({ absentCoaches: [3], unavailableEvents: [1, 2] })
      .expect(200)
    expect(updated.body.session.absentCoaches).toEqual([3])
    expect(updated.body.session.unavailableEvents).toEqual([1, 2])

    // A normal session edit must not clear the outages.
    await request(app)
      .put(`/api/sessions/${session.id}`)
      .set('Cookie', cookie)
      .send({ name: 'Renamed', date: '2026-03-03', startTime: '16:00', endTime: '18:00' })
      .expect(200)
    const after = await request(app).get(`/api/sessions/${session.id}`).set('Cookie', cookie)
    expect(after.body.session.absentCoaches).toEqual([3])
    expect(after.body.session.unavailableEvents).toEqual([1, 2])
  })

  it('copies a session, shifting the whole grid to the new start time', async () => {
    const eventId = (
      await request(app).post('/api/events').set('Cookie', cookie).send({ name: 'Vault' })
    ).body.event.id
    const classId = (
      await request(app).post('/api/classes').set('Cookie', cookie).send({ name: 'L3' })
    ).body.class.id
    const source = (
      await request(app)
        .post('/api/sessions')
        .set('Cookie', cookie)
        .send({
          name: 'Monday',
          date: '2026-03-02',
          startTime: '16:00',
          endTime: '18:30',
          classes: [classId],
        })
    ).body.session
    // A class on a partial window with one painted, locked block.
    await request(app)
      .put(`/api/sessions/${source.id}/schedule`)
      .set('Cookie', cookie)
      .send({
        placements: [
          {
            classId,
            columnIndex: 0,
            startMin: 960, // 16:00
            endMin: 1050, // 17:30
            blocks: [{ eventId, coachId: null, startMin: 960, endMin: 990, locked: true }],
          },
        ],
      })
      .expect(200)
    await request(app)
      .put(`/api/sessions/${source.id}/outages`)
      .set('Cookie', cookie)
      .send({ absentCoaches: [9], unavailableEvents: [] })
      .expect(200)

    const copy = (
      await request(app)
        .post(`/api/sessions/${source.id}/copy`)
        .set('Cookie', cookie)
        .send({ name: 'Thursday', date: '2026-03-05', startTime: '17:00' })
        .expect(201)
    ).body.session
    // Same window length and columns, chosen date/time, no outages.
    expect(copy).toMatchObject({
      name: 'Thursday',
      date: '2026-03-05',
      startTime: '17:00',
      endTime: '19:30',
      columnCount: 1,
      absentCoaches: [],
      unavailableEvents: [],
    })

    // The grid came along shifted by the +1h start delta, and the copied
    // block arrives unlocked so it can be regenerated over.
    const { schedule } = (
      await request(app).get(`/api/sessions/${copy.id}/schedule`).set('Cookie', cookie)
    ).body
    expect(schedule.placements).toMatchObject([
      { classId, columnIndex: 0, startMin: 1020, endMin: 1110 },
    ])
    expect(schedule.placements[0].blocks).toMatchObject([
      { eventId, coachId: null, startMin: 1020, endMin: 1050, locked: false },
    ])
  })

  it('rejects a copy that would run past midnight', async () => {
    const source = (
      await request(app)
        .post('/api/sessions')
        .set('Cookie', cookie)
        .send({ date: '2026-03-02', startTime: '16:00', endTime: '20:00' })
    ).body.session
    await request(app)
      .post(`/api/sessions/${source.id}/copy`)
      .set('Cookie', cookie)
      .send({ date: '2026-03-03', startTime: '21:00' })
      .expect(400)
  })

  it('rejects end before start and malformed times', async () => {
    await request(app)
      .post('/api/sessions')
      .set('Cookie', cookie)
      .send({ date: '2026-03-02', startTime: '18:00', endTime: '16:00' })
      .expect(400)
    await request(app)
      .post('/api/sessions')
      .set('Cookie', cookie)
      .send({ date: '2026-03-02', startTime: '4pm', endTime: '18:00' })
      .expect(400)
  })
})

describe('settings', () => {
  it('defaults to class mode and persists changes', async () => {
    const initial = await request(app).get('/api/settings').set('Cookie', cookie)
    expect(initial.body.settings.coachMode).toBe('class')

    await request(app)
      .put('/api/settings')
      .set('Cookie', cookie)
      .send({ coachMode: 'event' })
      .expect(200)

    const after = await request(app).get('/api/settings').set('Cookie', cookie)
    expect(after.body.settings.coachMode).toBe('event')
  })

  it('rejects unknown modes', async () => {
    await request(app)
      .put('/api/settings')
      .set('Cookie', cookie)
      .send({ coachMode: 'both' })
      .expect(400)
  })

  it('stores adjacency penalties and defaults to none', async () => {
    const initial = await request(app).get('/api/settings').set('Cookie', cookie)
    expect(initial.body.settings.adjacencyPenalties).toEqual([])

    await request(app)
      .put('/api/settings')
      .set('Cookie', cookie)
      .send({ adjacencyPenalties: [{ beforeEventId: 3, afterEventId: 1 }] })
      .expect(200)

    const after = await request(app).get('/api/settings').set('Cookie', cookie)
    expect(after.body.settings.adjacencyPenalties).toEqual([
      { beforeEventId: 3, afterEventId: 1 },
    ])
    // Updating one setting leaves the other untouched.
    expect(after.body.settings.coachMode).toBe('class')
  })

  it('rejects malformed adjacency penalties', async () => {
    await request(app)
      .put('/api/settings')
      .set('Cookie', cookie)
      .send({ adjacencyPenalties: [{ beforeEventId: 'x' }] })
      .expect(400)
  })
})
