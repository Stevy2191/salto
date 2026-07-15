import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { appWithAdmin } from './helpers.ts'

let app: Express
let cookie: string
let sessionId: number
let eventId: number
let classId: number
let coachId: number

beforeEach(async () => {
  ;({ app, cookie } = await appWithAdmin())
  eventId = (
    await request(app).post('/api/events').set('Cookie', cookie).send({ name: 'Vault' })
  ).body.event.id
  classId = (
    await request(app).post('/api/classes').set('Cookie', cookie).send({ name: 'Level 3' })
  ).body.class.id
  coachId = (
    await request(app).post('/api/coaches').set('Cookie', cookie).send({ name: 'Dana Marsh' })
  ).body.coach.id
  // 16:00–18:00 at 15 min → 8 slots (indexes 0..7)
  sessionId = (
    await request(app)
      .post('/api/sessions')
      .set('Cookie', cookie)
      .send({ date: '2026-03-02', startTime: '16:00', endTime: '18:00', classes: [classId] })
  ).body.session.id
})

function put(assignments: unknown) {
  return request(app)
    .put(`/api/sessions/${sessionId}/assignments`)
    .set('Cookie', cookie)
    .send({ assignments })
}

describe('assignments', () => {
  it('replaces and reads back the schedule', async () => {
    await put([
      { slotIndex: 0, eventId, classId, coachId },
      { slotIndex: 1, eventId, classId, coachId: null },
    ]).expect(200)

    const got = await request(app)
      .get(`/api/sessions/${sessionId}/assignments`)
      .set('Cookie', cookie)
    expect(got.body.assignments).toEqual([
      { slotIndex: 0, eventId, classId, coachId, locked: false },
      { slotIndex: 1, eventId, classId, coachId: null, locked: false },
    ])
  })

  it('round-trips the locked flag', async () => {
    await put([
      { slotIndex: 0, eventId, classId, coachId, locked: true },
      { slotIndex: 1, eventId, classId, coachId: null },
    ]).expect(200)

    const got = await request(app)
      .get(`/api/sessions/${sessionId}/assignments`)
      .set('Cookie', cookie)
    expect(got.body.assignments.map((a: { locked: boolean }) => a.locked)).toEqual([true, false])
  })

  it('rejects a non-boolean locked flag', async () => {
    await put([{ slotIndex: 0, eventId, classId, coachId: null, locked: 'yes' }]).expect(400)
  })

  it('full replace removes previous assignments', async () => {
    await put([{ slotIndex: 0, eventId, classId, coachId: null }]).expect(200)
    await put([{ slotIndex: 3, eventId, classId, coachId: null }]).expect(200)

    const got = await request(app)
      .get(`/api/sessions/${sessionId}/assignments`)
      .set('Cookie', cookie)
    expect(got.body.assignments).toEqual([
      { slotIndex: 3, eventId, classId, coachId: null, locked: false },
    ])
  })

  it('rejects a slot index beyond the session window', async () => {
    await put([{ slotIndex: 8, eventId, classId, coachId: null }]).expect(400)
  })

  it('rejects references to deleted rows', async () => {
    await request(app).delete(`/api/events/${eventId}`).set('Cookie', cookie).expect(204)
    const res = await put([{ slotIndex: 0, eventId, classId, coachId: null }])
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('no longer exists')
  })

  it('rejects duplicate cells', async () => {
    await put([
      { slotIndex: 0, eventId, classId, coachId: null },
      { slotIndex: 0, eventId, classId, coachId },
    ]).expect(400)
  })

  it('404s for an unknown session', async () => {
    await request(app)
      .put('/api/sessions/999/assignments')
      .set('Cookie', cookie)
      .send({ assignments: [] })
      .expect(404)
  })

  it('deleting the session deletes its assignments', async () => {
    await put([{ slotIndex: 0, eventId, classId, coachId: null }]).expect(200)
    await request(app).delete(`/api/sessions/${sessionId}`).set('Cookie', cookie).expect(204)
    await request(app)
      .get(`/api/sessions/${sessionId}/assignments`)
      .set('Cookie', cookie)
      .expect(404)
  })
})
