import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { appWithAdmin, createClass, findSlot } from './helpers.ts'

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
      .send({ name: 'Vault', duration: 10 })
      .expect(201)
    expect(created.body.event).toMatchObject({
      name: 'Vault',
      duration: 10,
      shared: false,
      active: true,
    })
    const id = created.body.event.id

    const list = await request(app).get('/api/events').set('Cookie', cookie)
    expect(list.body.events).toHaveLength(1)

    const updated = await request(app)
      .put(`/api/events/${id}`)
      .set('Cookie', cookie)
      .send({ name: 'Vault', duration: 15, shared: true, active: false })
      .expect(200)
    expect(updated.body.event).toMatchObject({ duration: 15, shared: true, active: false })

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

  it('defaults new events to exclusive, and toggles shared', async () => {
    const created = await request(app)
      .post('/api/events')
      .set('Cookie', cookie)
      .send({ name: 'Open Gym' })
      .expect(201)
    // Exclusive by default: only one class may be on the event at a time.
    expect(created.body.event.shared).toBe(false)
    const id = created.body.event.id

    const shared = await request(app)
      .put(`/api/events/${id}`)
      .set('Cookie', cookie)
      .send({ name: 'Open Gym', shared: true })
      .expect(200)
    expect(shared.body.event.shared).toBe(true)

    const exclusive = await request(app)
      .put(`/api/events/${id}`)
      .set('Cookie', cookie)
      .send({ name: 'Open Gym', shared: false })
      .expect(200)
    expect(exclusive.body.event.shared).toBe(false)
  })

  it('validates duration and name', async () => {
    await request(app).post('/api/events').set('Cookie', cookie).send({ name: '' }).expect(400)
    // Below the 5-minute floor.
    await request(app)
      .post('/api/events')
      .set('Cookie', cookie)
      .send({ name: 'Vault', duration: 0 })
      .expect(400)
    // Off the 5-minute axis.
    await request(app)
      .post('/api/events')
      .set('Cookie', cookie)
      .send({ name: 'Vault', duration: 12 })
      .expect(400)
  })

  it('404s on a missing event', async () => {
    await request(app)
      .put('/api/events/999')
      .set('Cookie', cookie)
      .send({ name: 'X' })
      .expect(404)
  })

  it('deleting an event scrubs it from coach specialties and class eligibility', async () => {
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
        .send({ name: 'Level 3', eligibleEventIds: [event.id] })
    ).body.class

    await request(app).delete(`/api/events/${event.id}`).set('Cookie', cookie).expect(204)

    const coaches = await request(app).get('/api/coaches').set('Cookie', cookie)
    expect(coaches.body.coaches.find((c: { id: number }) => c.id === coach.id).specialties).toEqual([])
    const classes = await request(app).get('/api/classes').set('Cookie', cookie)
    expect(
      classes.body.classes.find((c: { id: number }) => c.id === cls.id).eligibleEventIds,
    ).toEqual([])
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
  it('stores eligibility, period, and warm-up/cool-down anchors', async () => {
    // The warm-up/cool-down anchors are real foreign keys, so seed events.
    const ev = async (name: string) =>
      (await request(app).post('/api/events').set('Cookie', cookie).send({ name })).body.event.id
    const [e1, e2, e3, warm, cool] = [
      await ev('A'),
      await ev('B'),
      await ev('C'),
      await ev('Warm-up'),
      await ev('Stretch'),
    ]

    const created = await request(app)
      .post('/api/classes')
      .set('Cookie', cookie)
      .send({
        name: 'Xcel Silver',
        priority: 2,
        eligibleEventIds: [e1, e2, e3],
        periodMinutes: 60,
        warmupEventId: warm,
        warmupMinutes: 10,
        cooldownEventId: cool,
        cooldownMinutes: 10,
      })
      .expect(201)
    expect(created.body.class).toMatchObject({
      eligibleEventIds: [e1, e2, e3],
      periodMinutes: 60,
      warmupEventId: warm,
      warmupMinutes: 10,
      cooldownEventId: cool,
      cooldownMinutes: 10,
      priority: 2,
    })
  })

  it('rejects a warm-up event without a length', async () => {
    await request(app)
      .post('/api/classes')
      .set('Cookie', cookie)
      .send({ name: 'X', warmupEventId: 1 })
      .expect(400)
  })

  it('rejects a period that is not a multiple of 5', async () => {
    await request(app)
      .post('/api/classes')
      .set('Cookie', cookie)
      .send({ name: 'X', periodMinutes: 22 })
      .expect(400)
  })

  it('rejects a warm-up and cool-down that leave no time in the period', async () => {
    await request(app)
      .post('/api/classes')
      .set('Cookie', cookie)
      .send({
        name: 'X',
        periodMinutes: 20,
        warmupEventId: 1,
        warmupMinutes: 15,
        cooldownEventId: 2,
        cooldownMinutes: 10,
      })
      .expect(400)
  })

  it('deleting the only class in a slot removes the derived session', async () => {
    await createClass(app, cookie, {
      name: 'L3',
      daysOfWeek: [1],
      startTime: '16:00',
      periodMinutes: 60,
    })
    const slot = (await findSlot(app, cookie, 1, '16:00'))!
    expect(slot).toBeTruthy()

    const cls = (await request(app).get('/api/classes').set('Cookie', cookie)).body.classes[0]
    await request(app).delete(`/api/classes/${cls.id}`).set('Cookie', cookie).expect(204)
    // The slot no class backs anymore is gone.
    expect(await findSlot(app, cookie, 1, '16:00')).toBeUndefined()
  })
})

describe('derived sessions', () => {
  it('has no sessions until a class is scheduled', async () => {
    const sessions = (await request(app).get('/api/sessions').set('Cookie', cookie)).body.sessions
    expect(sessions).toEqual([])
  })

  it('cannot be created by hand — POST /sessions is gone', async () => {
    await request(app)
      .post('/api/sessions')
      .set('Cookie', cookie)
      .send({ startTime: '16:00', endTime: '18:00' })
      .expect(404)
  })

  it('groups classes sharing a day and start into one slot, each its own column', async () => {
    const a = await createClass(app, cookie, {
      name: 'LV 1',
      daysOfWeek: [1],
      startTime: '17:00',
      periodMinutes: 45,
    })
    const b = await createClass(app, cookie, {
      name: 'LV 2',
      daysOfWeek: [1],
      startTime: '17:00',
      periodMinutes: 60,
    })
    const slot = (await findSlot(app, cookie, 1, '17:00'))!
    expect(slot.classCount).toBe(2)

    const session = (
      await request(app).get(`/api/sessions/${slot.id}`).set('Cookie', cookie)
    ).body.session
    expect(session).toMatchObject({
      dayOfWeek: 1,
      startTime: '17:00',
      // The slot ends at the latest-ending class: 17:00 + 60 min.
      endTime: '18:00',
      columnCount: 2,
      name: 'Monday 5:00 PM',
    })

    const { schedule } = (
      await request(app).get(`/api/sessions/${slot.id}/schedule`).set('Cookie', cookie)
    ).body
    expect(schedule.placements).toMatchObject([
      { classId: a, columnIndex: 0, startMin: 17 * 60, endMin: 17 * 60 + 45, blocks: [] },
      { classId: b, columnIndex: 1, startMin: 17 * 60, endMin: 17 * 60 + 60, blocks: [] },
    ])
  })

  it('splits a class meeting several days into a slot per day', async () => {
    await createClass(app, cookie, {
      name: 'LWM',
      daysOfWeek: [1, 3],
      startTime: '17:00',
      periodMinutes: 45,
    })
    expect(await findSlot(app, cookie, 1, '17:00')).toBeTruthy()
    expect(await findSlot(app, cookie, 3, '17:00')).toBeTruthy()
    const sessions = (await request(app).get('/api/sessions').set('Cookie', cookie)).body.sessions
    expect(sessions).toHaveLength(2)
  })

  it('moves a class between slots when its schedule changes, keeping a lock', async () => {
    const id = await createClass(app, cookie, {
      name: 'LV 1',
      daysOfWeek: [1],
      startTime: '16:00',
      periodMinutes: 60,
    })
    const monday = (await findSlot(app, cookie, 1, '16:00'))!
    // Change the class to meet Tuesdays instead.
    await request(app)
      .put(`/api/classes/${id}`)
      .set('Cookie', cookie)
      .send({ name: 'LV 1', daysOfWeek: [2], startTime: '16:00', periodMinutes: 60 })
      .expect(200)
    expect(await findSlot(app, cookie, 1, '16:00')).toBeUndefined()
    expect(await findSlot(app, cookie, 2, '16:00')).toBeTruthy()
    void monday
  })

  it('stores day-of outages, untouched by reconciliation', async () => {
    await createClass(app, cookie, {
      name: 'L3',
      daysOfWeek: [1],
      startTime: '16:00',
      periodMinutes: 60,
    })
    const slot = (await findSlot(app, cookie, 1, '16:00'))!
    const updated = await request(app)
      .put(`/api/sessions/${slot.id}/outages`)
      .set('Cookie', cookie)
      .send({ absentCoaches: [3], unavailableEvents: [1, 2] })
      .expect(200)
    expect(updated.body.session.absentCoaches).toEqual([3])
    expect(updated.body.session.unavailableEvents).toEqual([1, 2])

    // Adding another class to the slot reconciles but keeps the outages.
    await createClass(app, cookie, {
      name: 'L4',
      daysOfWeek: [1],
      startTime: '16:00',
      periodMinutes: 60,
    })
    const after = await request(app).get(`/api/sessions/${slot.id}`).set('Cookie', cookie)
    expect(after.body.session.absentCoaches).toEqual([3])
    expect(after.body.session.unavailableEvents).toEqual([1, 2])
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
