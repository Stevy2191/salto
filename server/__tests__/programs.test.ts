import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { appWithAdmin } from './helpers.ts'

let app: Express
let cookie: string

beforeEach(async () => {
  ;({ app, cookie } = await appWithAdmin())
})

const post = (path: string, body: object) =>
  request(app).post(path).set('Cookie', cookie).send(body)

describe('programs CRUD', () => {
  it('creates, lists, updates, and deletes a program', async () => {
    const created = await post('/api/programs', {
      name: 'Preschool',
      defaultStartTime: '16:00',
      defaultEndTime: '17:00',
    }).expect(201)
    expect(created.body.program).toMatchObject({
      name: 'Preschool',
      defaultStartTime: '16:00',
      defaultEndTime: '17:00',
    })
    const id = created.body.program.id

    const list = await request(app).get('/api/programs').set('Cookie', cookie)
    expect(list.body.programs).toHaveLength(1)

    const updated = await request(app)
      .put(`/api/programs/${id}`)
      .set('Cookie', cookie)
      .send({ name: 'Preschool AM' })
      .expect(200)
    // Clearing the times is how a program says "use the session's window".
    expect(updated.body.program).toMatchObject({
      name: 'Preschool AM',
      defaultStartTime: null,
      defaultEndTime: null,
    })

    await request(app).delete(`/api/programs/${id}`).set('Cookie', cookie).expect(204)
    const after = await request(app).get('/api/programs').set('Cookie', cookie)
    expect(after.body.programs).toHaveLength(0)
  })

  it('requires auth', async () => {
    await request(app).get('/api/programs').expect(401)
    await request(app).post('/api/programs').send({ name: 'X' }).expect(401)
  })

  it('rejects a half-specified or backwards default window', async () => {
    await post('/api/programs', { name: 'A', defaultStartTime: '16:00' }).expect(400)
    await post('/api/programs', { name: 'A', defaultEndTime: '17:00' }).expect(400)
    await post('/api/programs', {
      name: 'A',
      defaultStartTime: '18:00',
      defaultEndTime: '17:00',
    }).expect(400)
  })

  it('rejects default times off the 5-minute axis', async () => {
    await post('/api/programs', {
      name: 'A',
      defaultStartTime: '16:02',
      defaultEndTime: '17:00',
    }).expect(400)
  })

  it('refuses to delete a program that still has classes', async () => {
    const program = (await post('/api/programs', { name: 'Rec Gym' })).body.program
    await post('/api/classes', { name: 'Rec Gym 1', programId: program.id }).expect(201)

    const res = await request(app)
      .delete(`/api/programs/${program.id}`)
      .set('Cookie', cookie)
      .expect(400)
    expect(res.body.error).toMatch(/still belongs to this program/)

    // Reassigning the class frees the program.
    const other = (await post('/api/programs', { name: 'Team' })).body.program
    const cls = (await request(app).get('/api/classes').set('Cookie', cookie)).body.classes[0]
    await request(app)
      .put(`/api/classes/${cls.id}`)
      .set('Cookie', cookie)
      .send({ name: cls.name, programId: other.id })
      .expect(200)
    await request(app).delete(`/api/programs/${program.id}`).set('Cookie', cookie).expect(204)
  })
})

describe('classes belong to a program and carry structure', () => {
  it('stores the program, per-event durations, positions, and its own window', async () => {
    const program = (
      await post('/api/programs', {
        name: 'Preschool',
        defaultStartTime: '16:00',
        defaultEndTime: '17:00',
      })
    ).body.program
    const created = await post('/api/classes', {
      name: 'Tiny Tot 1',
      programId: program.id,
      defaultStartTime: '16:15',
      defaultEndTime: '17:15',
      requiredEvents: [
        { eventId: 1, duration: 15, position: 'FIRST' },
        { eventId: 2, duration: 15 },
        { eventId: 3, duration: 15, position: 'LAST' },
      ],
    }).expect(201)

    expect(created.body.class).toMatchObject({
      programId: program.id,
      // A class's own clock overrides its program's.
      defaultStartTime: '16:15',
      defaultEndTime: '17:15',
    })
    expect(created.body.class.requiredEvents).toEqual([
      { eventId: 1, duration: 15, position: 'FIRST' },
      // An unstated position means "anywhere".
      { eventId: 2, duration: 15, position: 'ANY' },
      { eventId: 3, duration: 15, position: 'LAST' },
    ])
  })

  it('rejects an unknown position or program', async () => {
    await post('/api/classes', {
      name: 'X',
      requiredEvents: [{ eventId: 1, duration: 15, position: 'SECOND' }],
    }).expect(400)
    await post('/api/classes', { name: 'X', programId: 999 }).expect(404)
  })

  it('lets two classes in different programs want the same shared event', async () => {
    const a = (await post('/api/programs', { name: 'Preschool' })).body.program
    const b = (await post('/api/programs', { name: 'Rec Gym' })).body.program
    const trak = (await post('/api/events', { name: 'Tumble Trak' })).body.event
    await post('/api/classes', {
      name: 'Tiny Tot 1',
      programId: a.id,
      requiredEvents: [{ eventId: trak.id, duration: 15 }],
    }).expect(201)
    await post('/api/classes', {
      name: 'Rec Gym 1',
      programId: b.id,
      requiredEvents: [{ eventId: trak.id, duration: 10 }],
    }).expect(201)

    // Events are facility-wide: the contention is the generator's problem,
    // not something the model forbids.
    const classes = (await request(app).get('/api/classes').set('Cookie', cookie)).body.classes
    expect(classes.map((c: { requiredEvents: { duration: number }[] }) => c.requiredEvents[0].duration)).toEqual([15, 10])
  })
})
