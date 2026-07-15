import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { appWithAdmin } from './helpers.ts'

let app: Express
let cookie: string
let sessionId: number
let vaultId: number
let beamId: number
let coachId: number
let lv1: number
let lv2: number

// 16:00–20:00 in minutes since midnight — the times the grid stores.
const T = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h! * 60 + m!
}

beforeEach(async () => {
  ;({ app, cookie } = await appWithAdmin())
  const post = async (path: string, body: object) =>
    (await request(app).post(path).set('Cookie', cookie).send(body)).body

  vaultId = (await post('/api/events', { name: 'Vault' })).event.id
  beamId = (await post('/api/events', { name: 'Beam' })).event.id
  coachId = (await post('/api/coaches', { name: 'Dana Marsh' })).coach.id
  lv1 = (await post('/api/classes', { name: 'LV 1' })).class.id
  lv2 = (await post('/api/classes', { name: 'LV 2' })).class.id
  sessionId = (
    await post('/api/sessions', {
      name: 'Monday',
      date: '2026-03-02',
      startTime: '16:00',
      endTime: '20:00',
    })
  ).session.id
  // Two lanes to place into.
  await request(app)
    .put(`/api/sessions/${sessionId}/columns`)
    .set('Cookie', cookie)
    .send({ columnCount: 2 })
    .expect(200)
})

const save = (placements: unknown[]) =>
  request(app).put(`/api/sessions/${sessionId}/schedule`).set('Cookie', cookie).send({ placements })

const load = async () =>
  (await request(app).get(`/api/sessions/${sessionId}/schedule`).set('Cookie', cookie)).body
    .schedule

const placement = (over: Record<string, unknown> = {}) => ({
  classId: lv1,
  columnIndex: 0,
  startMin: T('16:00'),
  endMin: T('17:00'),
  blocks: [],
  ...over,
})

describe('placements', () => {
  it('stacks several classes in one column when their windows do not overlap', async () => {
    await save([
      placement({ classId: lv1, startMin: T('16:00'), endMin: T('17:00') }),
      placement({ classId: lv2, startMin: T('17:00'), endMin: T('18:00') }),
    ]).expect(200)

    const schedule = await load()
    expect(schedule.placements).toMatchObject([
      { classId: lv1, columnIndex: 0, startMin: T('16:00'), endMin: T('17:00') },
      { classId: lv2, columnIndex: 0, startMin: T('17:00'), endMin: T('18:00') },
    ])
  })

  it('rejects two classes overlapping in the same column, naming both', async () => {
    const res = await save([
      placement({ classId: lv1, startMin: T('16:00'), endMin: T('17:00') }),
      placement({ classId: lv2, startMin: T('16:30'), endMin: T('18:00') }),
    ]).expect(400)
    expect(res.body.error).toMatch(/LV 1/)
    expect(res.body.error).toMatch(/LV 2/)
    expect(res.body.error).toMatch(/column 1/)
  })

  it('allows the same overlap once the classes sit in different columns', async () => {
    await save([
      placement({ classId: lv1, columnIndex: 0, startMin: T('16:00'), endMin: T('17:00') }),
      placement({ classId: lv2, columnIndex: 1, startMin: T('16:30'), endMin: T('18:00') }),
    ]).expect(200)
    expect((await load()).placements).toHaveLength(2)
  })

  it('rejects a rejected save wholesale, leaving the stored grid untouched', async () => {
    await save([placement({ startMin: T('16:00'), endMin: T('17:00') })]).expect(200)
    await save([
      placement({ classId: lv1, startMin: T('16:00'), endMin: T('17:00') }),
      placement({ classId: lv2, startMin: T('16:30'), endMin: T('18:00') }),
    ]).expect(400)
    // The good earlier save survives — a bad PUT is not a partial write.
    expect((await load()).placements).toMatchObject([{ classId: lv1, endMin: T('17:00') }])
  })

  it('rejects a window outside the session', async () => {
    await save([placement({ startMin: T('15:00'), endMin: T('17:00') })]).expect(400)
    await save([placement({ startMin: T('19:00'), endMin: T('21:00') })]).expect(400)
  })

  it('rejects times off the 5-minute axis', async () => {
    const res = await save([placement({ startMin: T('16:02'), endMin: T('17:00') })]).expect(400)
    expect(res.body.error).toMatch(/5-minute/)
  })

  it('rejects a backwards or empty window', async () => {
    await save([placement({ startMin: T('17:00'), endMin: T('16:00') })]).expect(400)
    await save([placement({ startMin: T('17:00'), endMin: T('17:00') })]).expect(400)
  })

  it('rejects a column that does not exist', async () => {
    await save([placement({ columnIndex: 5 })]).expect(400)
  })
})

describe('event blocks', () => {
  it('round-trips painted blocks inside a class window', async () => {
    await save([
      placement({
        blocks: [
          { eventId: vaultId, coachId, startMin: T('16:00'), endMin: T('16:25'), locked: false },
          { eventId: beamId, coachId: null, startMin: T('16:25'), endMin: T('17:00'), locked: true },
        ],
      }),
    ]).expect(200)

    const schedule = await load()
    expect(schedule.placements[0].blocks).toMatchObject([
      { eventId: vaultId, coachId, startMin: T('16:00'), endMin: T('16:25'), locked: false },
      { eventId: beamId, coachId: null, startMin: T('16:25'), endMin: T('17:00'), locked: true },
    ])
  })

  it('keeps two consecutive blocks on the same event distinct', async () => {
    // The boundary between them has to survive the round trip — merging
    // equal neighbours would erase it.
    await save([
      placement({
        blocks: [
          { eventId: vaultId, coachId: null, startMin: T('16:00'), endMin: T('16:30') },
          { eventId: vaultId, coachId: null, startMin: T('16:30'), endMin: T('17:00') },
        ],
      }),
    ]).expect(200)
    expect((await load()).placements[0].blocks).toHaveLength(2)
  })

  it('rejects a block outside its class window, naming the class', async () => {
    const res = await save([
      placement({
        startMin: T('16:00'),
        endMin: T('17:00'),
        blocks: [{ eventId: vaultId, coachId: null, startMin: T('17:00'), endMin: T('17:30') }],
      }),
    ]).expect(400)
    expect(res.body.error).toMatch(/LV 1/)
  })

  it('rejects overlapping blocks within a class', async () => {
    const res = await save([
      placement({
        blocks: [
          { eventId: vaultId, coachId: null, startMin: T('16:00'), endMin: T('16:40') },
          { eventId: beamId, coachId: null, startMin: T('16:30'), endMin: T('17:00') },
        ],
      }),
    ]).expect(400)
    expect(res.body.error).toMatch(/overlap/)
  })

  it('rejects blocks off the 5-minute axis', async () => {
    await save([
      placement({
        blocks: [{ eventId: vaultId, coachId: null, startMin: T('16:00'), endMin: T('16:07') }],
      }),
    ]).expect(400)
  })

  it('rejects a block on an event that no longer exists', async () => {
    const res = await save([
      placement({
        blocks: [{ eventId: 9999, coachId: null, startMin: T('16:00'), endMin: T('16:30') }],
      }),
    ]).expect(400)
    expect(res.body.error).toMatch(/no longer exists/)
  })
})

describe('columns', () => {
  it('adds empty lanes to place into', async () => {
    const res = await request(app)
      .put(`/api/sessions/${sessionId}/columns`)
      .set('Cookie', cookie)
      .send({ columnCount: 5 })
      .expect(200)
    expect(res.body.session.columnCount).toBe(5)
  })

  it('refuses to remove a column that still holds a class', async () => {
    await save([placement({ columnIndex: 1 })]).expect(200)
    const res = await request(app)
      .put(`/api/sessions/${sessionId}/columns`)
      .set('Cookie', cookie)
      .send({ columnCount: 1 })
      .expect(400)
    expect(res.body.error).toMatch(/still holds classes/)
  })
})

describe('schedule auth and 404s', () => {
  it('requires a session cookie', async () => {
    await request(app).get(`/api/sessions/${sessionId}/schedule`).expect(401)
  })

  it('404s on a missing session', async () => {
    await request(app).get('/api/sessions/9999/schedule').set('Cookie', cookie).expect(404)
  })
})
