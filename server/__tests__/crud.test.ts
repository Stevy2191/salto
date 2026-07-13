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
    await request(app).post('/api/groups').send({ name: 'X' }).expect(401)
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

  it('deleting an event scrubs it from coach specialties and group requirements', async () => {
    const event = (
      await request(app).post('/api/events').set('Cookie', cookie).send({ name: 'Beam' })
    ).body.event
    const coach = (
      await request(app)
        .post('/api/coaches')
        .set('Cookie', cookie)
        .send({ name: 'Riley Cho', specialties: [event.id] })
    ).body.coach
    const group = (
      await request(app)
        .post('/api/groups')
        .set('Cookie', cookie)
        .send({ name: 'Level 3', requiredEvents: [{ eventId: event.id, duration: 30 }] })
    ).body.group

    await request(app).delete(`/api/events/${event.id}`).set('Cookie', cookie).expect(204)

    const coaches = await request(app).get('/api/coaches').set('Cookie', cookie)
    expect(coaches.body.coaches.find((c: { id: number }) => c.id === coach.id).specialties).toEqual([])
    const groups = await request(app).get('/api/groups').set('Cookie', cookie)
    expect(groups.body.groups.find((g: { id: number }) => g.id === group.id).requiredEvents).toEqual([])
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

  it('deleting a coach scrubs group assignments', async () => {
    const coach = (
      await request(app).post('/api/coaches').set('Cookie', cookie).send({ name: 'Sam Ortiz' })
    ).body.coach
    const group = (
      await request(app)
        .post('/api/groups')
        .set('Cookie', cookie)
        .send({ name: 'Boys Team', assignedCoaches: [coach.id] })
    ).body.group

    await request(app).delete(`/api/coaches/${coach.id}`).set('Cookie', cookie).expect(204)
    const groups = await request(app).get('/api/groups').set('Cookie', cookie)
    expect(groups.body.groups.find((g: { id: number }) => g.id === group.id).assignedCoaches).toEqual([])
  })
})

describe('groups CRUD', () => {
  it('stores required events with durations', async () => {
    const created = await request(app)
      .post('/api/groups')
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
    expect(created.body.group.requiredEvents).toHaveLength(2)
    expect(created.body.group.priority).toBe(2)
  })

  it('rejects malformed required events', async () => {
    await request(app)
      .post('/api/groups')
      .set('Cookie', cookie)
      .send({ name: 'X', requiredEvents: [{ eventId: 1 }] })
      .expect(400)
  })

  it('rejects required-event durations that are not multiples of 5', async () => {
    await request(app)
      .post('/api/groups')
      .set('Cookie', cookie)
      .send({ name: 'X', requiredEvents: [{ eventId: 1, duration: 22 }] })
      .expect(400)
  })

  it('deleting a group scrubs sessions', async () => {
    const group = (
      await request(app).post('/api/groups').set('Cookie', cookie).send({ name: 'L3' })
    ).body.group
    const session = (
      await request(app)
        .post('/api/sessions')
        .set('Cookie', cookie)
        .send({ dayOfWeek: 1, startTime: '16:00', endTime: '18:00', groups: [group.id] })
    ).body.session

    await request(app).delete(`/api/groups/${group.id}`).set('Cookie', cookie).expect(204)
    const sessions = await request(app).get('/api/sessions').set('Cookie', cookie)
    expect(sessions.body.sessions.find((s: { id: number }) => s.id === session.id).groups).toEqual([])
  })
})

describe('sessions CRUD', () => {
  it('creates a session with defaults', async () => {
    const created = await request(app)
      .post('/api/sessions')
      .set('Cookie', cookie)
      .send({ dayOfWeek: 1, startTime: '16:00', endTime: '18:30' })
      .expect(201)
    expect(created.body.session).toMatchObject({
      dayOfWeek: 1,
      startTime: '16:00',
      endTime: '18:30',
      rotationLength: 15,
      groups: [],
    })
  })

  it('accepts any 5-minute multiple as rotation length', async () => {
    const created = await request(app)
      .post('/api/sessions')
      .set('Cookie', cookie)
      .send({ dayOfWeek: 2, startTime: '17:00', endTime: '19:05', rotationLength: 25 })
      .expect(201)
    expect(created.body.session.rotationLength).toBe(25)
  })

  it('rejects rotation lengths that are not multiples of 5', async () => {
    await request(app)
      .post('/api/sessions')
      .set('Cookie', cookie)
      .send({ dayOfWeek: 2, startTime: '17:00', endTime: '19:00', rotationLength: 17 })
      .expect(400)
  })

  it('stores day-of outages separately from session edits', async () => {
    const session = (
      await request(app)
        .post('/api/sessions')
        .set('Cookie', cookie)
        .send({ dayOfWeek: 1, startTime: '16:00', endTime: '18:00' })
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
      .send({ name: 'Renamed', dayOfWeek: 2, startTime: '16:00', endTime: '18:00' })
      .expect(200)
    const after = await request(app).get(`/api/sessions/${session.id}`).set('Cookie', cookie)
    expect(after.body.session.absentCoaches).toEqual([3])
    expect(after.body.session.unavailableEvents).toEqual([1, 2])
  })

  it('copies a session with schedule, groups, and duration', async () => {
    const eventId = (
      await request(app).post('/api/events').set('Cookie', cookie).send({ name: 'Vault' })
    ).body.event.id
    const groupId = (
      await request(app).post('/api/groups').set('Cookie', cookie).send({ name: 'L3' })
    ).body.group.id
    const source = (
      await request(app)
        .post('/api/sessions')
        .set('Cookie', cookie)
        .send({
          name: 'Monday',
          dayOfWeek: 1,
          startTime: '16:00',
          endTime: '18:30',
          rotationLength: 30,
          groups: [groupId],
        })
    ).body.session
    await request(app)
      .put(`/api/sessions/${source.id}/assignments`)
      .set('Cookie', cookie)
      .send({ assignments: [{ slotIndex: 0, eventId, groupId, coachId: null, locked: true }] })
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
        .send({ name: 'Thursday', dayOfWeek: 4, startTime: '17:00' })
        .expect(201)
    ).body.session
    // Same duration and rotation, chosen day/time, same groups, no outages.
    expect(copy).toMatchObject({
      name: 'Thursday',
      dayOfWeek: 4,
      startTime: '17:00',
      endTime: '19:30',
      rotationLength: 30,
      groups: [groupId],
      absentCoaches: [],
      unavailableEvents: [],
    })
    // Schedule copied, arriving unlocked.
    const assignments = (
      await request(app).get(`/api/sessions/${copy.id}/assignments`).set('Cookie', cookie)
    ).body.assignments
    expect(assignments).toEqual([
      { slotIndex: 0, eventId, groupId, coachId: null, locked: false },
    ])
  })

  it('rejects a copy that would run past midnight', async () => {
    const source = (
      await request(app)
        .post('/api/sessions')
        .set('Cookie', cookie)
        .send({ dayOfWeek: 1, startTime: '16:00', endTime: '20:00' })
    ).body.session
    await request(app)
      .post(`/api/sessions/${source.id}/copy`)
      .set('Cookie', cookie)
      .send({ dayOfWeek: 2, startTime: '21:00' })
      .expect(400)
  })

  it('rejects end before start and malformed times', async () => {
    await request(app)
      .post('/api/sessions')
      .set('Cookie', cookie)
      .send({ dayOfWeek: 1, startTime: '18:00', endTime: '16:00' })
      .expect(400)
    await request(app)
      .post('/api/sessions')
      .set('Cookie', cookie)
      .send({ dayOfWeek: 1, startTime: '4pm', endTime: '18:00' })
      .expect(400)
  })
})

describe('settings', () => {
  it('defaults to group mode and persists changes', async () => {
    const initial = await request(app).get('/api/settings').set('Cookie', cookie)
    expect(initial.body.settings.coachMode).toBe('group')

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
    expect(after.body.settings.coachMode).toBe('group')
  })

  it('rejects malformed adjacency penalties', async () => {
    await request(app)
      .put('/api/settings')
      .set('Cookie', cookie)
      .send({ adjacencyPenalties: [{ beforeEventId: 'x' }] })
      .expect(400)
  })
})
