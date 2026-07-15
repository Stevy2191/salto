import { Router } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import { ApiError } from '../validate.ts'
import { withTransaction } from '../tx.ts'
import { EVENT_PALETTE } from '../../shared/colors.ts'
import { addDays, dayOfWeekOf, todayIsoDate } from '../../shared/dates.ts'
import { parseTime } from '../../shared/slots.ts'

// Clearly fictional sample data so a new gym can explore the app before
// entering its own. Every row is flagged is_sample so it can be removed
// in one click.
//
// The sample session is built to show the lane model rather than a tidy
// rectangle: one column runs three classes back to back, one class runs the
// whole session, and others take partial windows, leaving real blank time.

function sampleLoaded(db: DatabaseSync): boolean {
  for (const table of ['events', 'coaches', 'groups', 'sessions']) {
    const row = db.prepare(`SELECT 1 AS x FROM ${table} WHERE is_sample = 1 LIMIT 1`).get()
    if (row) return true
  }
  return false
}

const at = (hhmm: string) => parseTime(hhmm)!

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
  const classIds: Record<string, number> = {}
  const classes: [string, number, [number, number][], number[]][] = [
    // Short rec classes that share one lane, one after another.
    ['LV 1', 0, [[eventIds['Floor']!, 20], [eventIds['Tumble Track']!, 20]], [coachIds['Dana Marsh']!]],
    ['LV 2', 0, [[eventIds['Vault']!, 20], [eventIds['Floor']!, 20]], [coachIds['Dana Marsh']!]],
    ['VYC 2', 1, [[eventIds['Tumble Track']!, 30], [eventIds['Conditioning']!, 30]], [coachIds['Sam Ortiz']!]],
    // Team classes on their own lanes.
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
      ],
      [coachIds['Jules Baptiste']!],
    ],
    [
      'Boys Team',
      2,
      [
        [eventIds['Floor']!, 30],
        [eventIds['Tumble Track']!, 30],
        [eventIds['Conditioning']!, 30],
      ],
      [coachIds['Sam Ortiz']!],
    ],
  ]
  for (const [name, priority, required, coaches] of classes) {
    const requiredEvents = required.map(([eventId, duration]) => ({ eventId, duration }))
    classIds[name] = Number(
      insertClass.run(name, priority, JSON.stringify(requiredEvents), JSON.stringify(coaches))
        .lastInsertRowid,
    )
  }

  // Sessions are per-date. Seed the next Monday and Wednesday from today so
  // the sample gym always shows upcoming practices, never stale ones.
  const insertSession = db.prepare(
    'INSERT INTO sessions (name, date, start_time, end_time, column_count, is_sample) VALUES (?, ?, ?, ?, ?, 1)',
  )
  const today = todayIsoDate()
  const todayDow = dayOfWeekOf(today)
  const nextWeekday = (dow: number) => addDays(today, (dow - todayDow + 7) % 7)

  const insertPlacement = db.prepare(
    'INSERT INTO placements (session_id, class_id, column_index, start_min, end_min) VALUES (?, ?, ?, ?, ?)',
  )
  const insertBlock = db.prepare(
    'INSERT INTO event_blocks (placement_id, event_id, coach_id, start_min, end_min, locked) VALUES (?, ?, ?, ?, ?, 0)',
  )

  /** A class in a column for a window, optionally with painted blocks. */
  type Lane = {
    className: string
    column: number
    start: string
    end: string
    blocks?: [string, string, string, string | null][] // event, from, to, coach
  }

  const buildSession = (name: string, date: string, lanes: Lane[]) => {
    const columnCount = Math.max(...lanes.map((l) => l.column)) + 1
    const sessionId = Number(
      insertSession.run(name, date, '16:00', '20:00', columnCount).lastInsertRowid,
    )
    for (const lane of lanes) {
      const placementId = Number(
        insertPlacement.run(
          sessionId,
          classIds[lane.className]!,
          lane.column,
          at(lane.start),
          at(lane.end),
        ).lastInsertRowid,
      )
      for (const [eventName, from, to, coachName] of lane.blocks ?? []) {
        insertBlock.run(
          placementId,
          eventIds[eventName]!,
          coachName === null ? null : coachIds[coachName]!,
          at(from),
          at(to),
        )
      }
    }
    return sessionId
  }

  // Monday: a 4:00–8:00 session showing every shape of the model.
  buildSession('Monday Team Practice', nextWeekday(1), [
    // One lane, three classes back to back — the rec pipeline.
    {
      className: 'LV 1',
      column: 0,
      start: '16:00',
      end: '17:00',
      blocks: [
        ['Floor', '16:00', '16:30', 'Dana Marsh'],
        ['Tumble Track', '16:30', '17:00', 'Dana Marsh'],
      ],
    },
    {
      className: 'LV 2',
      column: 0,
      start: '17:00',
      end: '18:00',
      blocks: [
        ['Vault', '17:00', '17:25', 'Dana Marsh'],
        ['Floor', '17:25', '18:00', 'Dana Marsh'],
      ],
    },
    {
      className: 'VYC 2',
      column: 0,
      start: '18:00',
      end: '20:00',
      blocks: [
        ['Tumble Track', '18:00', '18:45', 'Sam Ortiz'],
        ['Conditioning', '18:45', '19:15', 'Sam Ortiz'],
      ],
    },
    // A class running the whole session.
    {
      className: 'Level 5 Girls',
      column: 1,
      start: '16:00',
      end: '20:00',
      blocks: [
        ['Vault', '16:00', '16:30', 'Riley Cho'],
        ['Uneven Bars', '16:30', '17:00', 'Riley Cho'],
        ['Balance Beam', '17:00', '17:30', 'Riley Cho'],
        ['Floor', '17:30', '18:00', 'Riley Cho'],
      ],
    },
    // Partial windows: one leaves late, one arrives late.
    {
      className: 'Xcel Silver',
      column: 2,
      start: '16:00',
      end: '19:00',
      blocks: [
        ['Uneven Bars', '17:00', '17:30', 'Jules Baptiste'],
        ['Balance Beam', '17:30', '18:00', 'Jules Baptiste'],
      ],
    },
    { className: 'Boys Team', column: 3, start: '17:30', end: '20:00' },
  ])

  // Wednesday: same gym, a lighter evening — left unpainted so the example
  // has somewhere obvious to try painting or generating.
  buildSession('Wednesday Team Practice', nextWeekday(3), [
    { className: 'LV 1', column: 0, start: '16:00', end: '17:00' },
    { className: 'VYC 2', column: 0, start: '17:00', end: '19:00' },
    { className: 'Level 5 Girls', column: 1, start: '16:00', end: '20:00' },
    { className: 'Boys Team', column: 2, start: '16:30', end: '19:30' },
  ])
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
      // Sessions cascade-delete their placements, which cascade to blocks.
      for (const table of ['sessions', 'groups', 'coaches', 'events']) {
        db.prepare(`DELETE FROM ${table} WHERE is_sample = 1`).run()
      }
    })
    res.status(204).end()
  })

  return router
}
