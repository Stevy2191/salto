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
