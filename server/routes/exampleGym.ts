import { Router } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import { ApiError } from '../validate.ts'
import { withTransaction } from '../tx.ts'
import { EVENT_PALETTE } from '../../shared/colors.ts'

// Clearly fictional sample data so a new gym can explore the app before
// entering its own. Every row is flagged is_sample so it can be removed
// in one click.

function sampleLoaded(db: DatabaseSync): boolean {
  for (const table of ['events', 'coaches', 'groups', 'sessions']) {
    const row = db.prepare(`SELECT 1 AS x FROM ${table} WHERE is_sample = 1 LIMIT 1`).get()
    if (row) return true
  }
  return false
}

function seed(db: DatabaseSync): void {
  const insertEvent = db.prepare(
    'INSERT INTO events (name, capacity, active, color, is_sample) VALUES (?, ?, 1, ?, 1)',
  )
  const eventIds: Record<string, number> = {}
  // A mix of limited and unlimited events: apparatus fit one class,
  // Floor fits two, Conditioning has no limit (null capacity).
  const sampleEvents: [string, number | null][] = [
    ['Vault', 1],
    ['Uneven Bars', 1],
    ['Balance Beam', 1],
    ['Floor', 2],
    ['Tumble Track', 1],
    ['Conditioning', null],
  ]
  sampleEvents.forEach(([name, capacity], index) => {
    eventIds[name] = Number(
      insertEvent.run(name, capacity, EVENT_PALETTE[index % EVENT_PALETTE.length]!).lastInsertRowid,
    )
  })

  const insertCoach = db.prepare(
    'INSERT INTO coaches (name, specialties, availability, is_sample) VALUES (?, ?, ?, 1)',
  )
  const weekdays = [1, 2, 3, 4, 5]
  const coachIds: Record<string, number> = {}
  for (const [name, specialties] of [
    ['Dana Marsh', [eventIds['Vault'], eventIds['Floor'], eventIds['Tumble Track']]],
    ['Riley Cho', [eventIds['Uneven Bars'], eventIds['Balance Beam']]],
    ['Sam Ortiz', [eventIds['Floor'], eventIds['Conditioning'], eventIds['Vault']]],
    ['Jules Baptiste', [eventIds['Balance Beam'], eventIds['Tumble Track'], eventIds['Conditioning']]],
  ] as const) {
    coachIds[name] = Number(
      insertCoach.run(name, JSON.stringify(specialties), JSON.stringify(weekdays)).lastInsertRowid,
    )
  }

  const insertClass = db.prepare(
    'INSERT INTO groups (name, priority, required_events, assigned_coaches, is_sample) VALUES (?, ?, ?, ?, 1)',
  )
  const classIds: number[] = []
  const classes: [string, number, [number, number][], number[]][] = [
    [
      'Level 3 Girls',
      1,
      [
        [eventIds['Vault']!, 15],
        [eventIds['Uneven Bars']!, 30],
        [eventIds['Balance Beam']!, 30],
        [eventIds['Floor']!, 30],
        [eventIds['Conditioning']!, 15],
      ],
      [coachIds['Dana Marsh']!],
    ],
    [
      'Level 5 Girls',
      2,
      [
        [eventIds['Vault']!, 30],
        [eventIds['Uneven Bars']!, 30],
        [eventIds['Balance Beam']!, 30],
        [eventIds['Floor']!, 30],
      ],
      [coachIds['Riley Cho']!],
    ],
    [
      'Xcel Silver',
      1,
      [
        [eventIds['Uneven Bars']!, 30],
        [eventIds['Balance Beam']!, 30],
        [eventIds['Floor']!, 30],
        [eventIds['Conditioning']!, 30],
      ],
      [coachIds['Jules Baptiste']!],
    ],
    [
      'Boys Team',
      2,
      [
        [eventIds['Floor']!, 30],
        [eventIds['Tumble Track']!, 30],
        [eventIds['Vault']!, 30],
        [eventIds['Conditioning']!, 30],
      ],
      [coachIds['Sam Ortiz']!],
    ],
  ]
  for (const [name, priority, required, coaches] of classes) {
    const requiredEvents = required.map(([eventId, duration]) => ({ eventId, duration }))
    classIds.push(
      Number(
        insertClass.run(name, priority, JSON.stringify(requiredEvents), JSON.stringify(coaches))
          .lastInsertRowid,
      ),
    )
  }

  db.prepare(
    'INSERT INTO sessions (name, day_of_week, start_time, end_time, rotation_length, groups, is_sample) VALUES (?, ?, ?, ?, ?, ?, 1)',
  ).run('Monday Team Practice', 1, '16:00', '18:30', 15, JSON.stringify(classIds))
}

export function exampleGymRoutes(db: DatabaseSync): Router {
  const router = Router()

  router.get('/example-gym', (_req, res) => {
    res.json({ loaded: sampleLoaded(db) })
  })

  router.post('/example-gym', (_req, res) => {
    if (sampleLoaded(db)) {
      throw new ApiError(409, 'example gym data is already loaded')
    }
    withTransaction(db, () => seed(db))
    res.status(201).json({ loaded: true })
  })

  router.delete('/example-gym', (_req, res) => {
    withTransaction(db, () => {
      // Sessions cascade-delete their assignments.
      for (const table of ['sessions', 'groups', 'coaches', 'events']) {
        db.prepare(`DELETE FROM ${table} WHERE is_sample = 1`).run()
      }
    })
    res.status(204).end()
  })

  return router
}
