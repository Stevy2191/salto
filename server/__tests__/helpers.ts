import request from 'supertest'
import type { Express } from 'express'
import { createApp } from '../app.ts'
import { openDb } from '../db.ts'

/** An app with a fresh in-memory DB and a logged-in admin; returns the session cookie. */
export async function appWithAdmin(): Promise<{ app: Express; cookie: string }> {
  const app = createApp(openDb(':memory:'))
  const res = await request(app)
    .post('/api/setup')
    .send({ username: 'admin', password: 'correct-horse' })
  const cookie = res.headers['set-cookie']![0]!.split(';')[0]!
  return { app, cookie }
}

/** Create a scheduled class; sessions are auto-derived from its day/time. */
export async function createClass(
  app: Express,
  cookie: string,
  body: Record<string, unknown>,
): Promise<number> {
  const res = await request(app).post('/api/classes').set('Cookie', cookie).send(body)
  if (res.status !== 201) throw new Error(`createClass failed: ${JSON.stringify(res.body)}`)
  return res.body.class.id as number
}

/** The derived session slot for a (dayOfWeek, startTime), or undefined. */
export async function findSlot(
  app: Express,
  cookie: string,
  dayOfWeek: number,
  startTime: string,
): Promise<{ id: number; classCount: number } | undefined> {
  const res = await request(app).get('/api/sessions').set('Cookie', cookie)
  return res.body.sessions.find(
    (s: { dayOfWeek: number; startTime: string }) =>
      s.dayOfWeek === dayOfWeek && s.startTime === startTime,
  )
}
