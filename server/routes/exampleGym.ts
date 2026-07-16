import { Router } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import { ApiError } from '../validate.ts'
import { withTransaction } from '../tx.ts'
import { EVENT_PALETTE } from '../../shared/colors.ts'
import { addDays, dayOfWeekOf, todayIsoDate } from '../../shared/dates.ts'
import { parseTime } from '../../shared/slots.ts'
import type { EventPosition } from '../../shared/types.ts'

// Clearly fictional sample data so a new gym can explore the app before
// entering its own. Every row is flagged is_sample so it can be removed
// in one click.
//
// It is built to demonstrate the whole model rather than to look tidy:
// three programs on staggered clocks, classes with per-class durations,
// warm-up/cool-down anchors, and — the point of the generator — a Tumble
// Trak that classes from different programs all contend for. Hitting
// Generate on it should produce a clean, conflict-free rotation.

function sampleLoaded(db: DatabaseSync): boolean {
  for (const table of ['events', 'coaches', 'groups', 'sessions', 'programs']) {
    const row = db.prepare(`SELECT 1 AS x FROM ${table} WHERE is_sample = 1 LIMIT 1`).get()
    if (row) return true
  }
  return false
}

const at = (hhmm: string) => parseTime(hhmm)!

interface ClassSpec {
  name: string
  priority: number
  /** [event, minutes, position] */
  events: [string, number, EventPosition][]
  coach: string
  /** Overrides the program's clock. */
  window?: [string, string]
}

function seed(db: DatabaseSync): void {
  const insertEvent = db.prepare(
    'INSERT INTO events (name, capacity, active, color, is_sample) VALUES (?, ?, 1, ?, 1)',
  )
  const eventIds: Record<string, number> = {}
  // Apparatus fit one class at a time — that is what makes the schedule a
  // puzzle. Warm-up and Stretch are open mat space with no limit, which is
  // what lets every class start and finish on them.
  const sampleEvents: [string, number | null][] = [
    ['Warm-up', null],
    ['Tumble Trak', 1],
    ['Vault', 1],
    ['Bars', 1],
    ['Beam', 1],
    ['Floor', 2],
    ['Trampoline', 1],
    ['Stretch', null],
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
  const every = Object.values(eventIds)
  for (const name of ['Dana Marsh', 'Riley Cho', 'Sam Ortiz', 'Jules Baptiste']) {
    coachIds[name] = Number(
      insertCoach.run(name, JSON.stringify(every), JSON.stringify(weekdays)).lastInsertRowid,
    )
  }

  const insertProgram = db.prepare(
    'INSERT INTO programs (name, default_start_time, default_end_time, is_sample) VALUES (?, ?, ?, 1)',
  )
  const insertClass = db.prepare(
    `INSERT INTO groups (name, program_id, priority, required_events, assigned_coaches,
                         default_start_time, default_end_time, is_sample)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
  )
  const classIds: Record<string, number> = {}

  // Three programs on staggered clocks. Preschool is short and early, Rec
  // Gym overlaps it, Team runs long into the evening — so the Tumble Trak
  // is genuinely fought over in the middle.
  const programs: { name: string; window: [string, string]; classes: ClassSpec[] }[] = [
    {
      name: 'Preschool',
      window: ['16:00', '17:00'],
      classes: [
        {
          name: 'Tiny Tot 1',
          priority: 0,
          coach: 'Dana Marsh',
          // 15 min per event — little ones stay put longer.
          events: [
            ['Warm-up', 15, 'FIRST'],
            ['Tumble Trak', 15, 'ANY'],
            ['Floor', 15, 'ANY'],
            ['Stretch', 10, 'LAST'],
          ],
        },
        {
          name: 'Tiny Tot 2',
          priority: 0,
          coach: 'Dana Marsh',
          events: [
            ['Warm-up', 15, 'FIRST'],
            ['Trampoline', 15, 'ANY'],
            ['Tumble Trak', 15, 'ANY'],
            ['Stretch', 10, 'LAST'],
          ],
        },
      ],
    },
    {
      name: 'Rec Gym',
      window: ['16:30', '18:00'],
      classes: [
        {
          name: 'Rec Gym 1',
          priority: 1,
          coach: 'Sam Ortiz',
          // 10 min per event — rec classes rotate faster.
          events: [
            ['Warm-up', 10, 'FIRST'],
            ['Vault', 10, 'ANY'],
            ['Tumble Trak', 10, 'ANY'],
            ['Floor', 10, 'ANY'],
            ['Stretch', 10, 'LAST'],
          ],
        },
        {
          name: 'Rec Gym 2',
          priority: 1,
          coach: 'Sam Ortiz',
          events: [
            ['Warm-up', 10, 'FIRST'],
            ['Trampoline', 10, 'ANY'],
            ['Tumble Trak', 10, 'ANY'],
            ['Beam', 10, 'ANY'],
            ['Stretch', 10, 'LAST'],
          ],
        },
        {
          name: 'Rec Gym 3',
          priority: 1,
          coach: 'Jules Baptiste',
          // Arrives late — a class on its own clock inside its program.
          window: ['17:00', '18:30'],
          events: [
            ['Warm-up', 10, 'FIRST'],
            ['Floor', 15, 'ANY'],
            ['Bars', 15, 'ANY'],
            ['Stretch', 10, 'LAST'],
          ],
        },
      ],
    },
    {
      name: 'Team',
      window: ['17:30', '20:00'],
      classes: [
        {
          name: 'Level 3 Girls',
          priority: 2,
          coach: 'Riley Cho',
          events: [
            ['Warm-up', 20, 'FIRST'],
            ['Vault', 30, 'ANY'],
            ['Bars', 30, 'ANY'],
            ['Beam', 30, 'ANY'],
            ['Stretch', 15, 'LAST'],
          ],
        },
        {
          name: 'Level 5 Girls',
          priority: 2,
          coach: 'Riley Cho',
          events: [
            ['Warm-up', 20, 'FIRST'],
            ['Bars', 30, 'ANY'],
            ['Beam', 30, 'ANY'],
            ['Floor', 30, 'ANY'],
            ['Stretch', 15, 'LAST'],
          ],
        },
        {
          name: 'Boys Team',
          priority: 2,
          coach: 'Jules Baptiste',
          events: [
            ['Warm-up', 20, 'FIRST'],
            ['Vault', 30, 'ANY'],
            ['Tumble Trak', 30, 'ANY'],
            ['Floor', 30, 'ANY'],
            ['Stretch', 15, 'LAST'],
          ],
        },
      ],
    },
  ]

  for (const program of programs) {
    const programId = Number(
      insertProgram.run(program.name, program.window[0], program.window[1]).lastInsertRowid,
    )
    for (const spec of program.classes) {
      const requiredEvents = spec.events.map(([name, duration, position]) => ({
        eventId: eventIds[name]!,
        duration,
        position,
      }))
      classIds[spec.name] = Number(
        insertClass.run(
          spec.name,
          programId,
          spec.priority,
          JSON.stringify(requiredEvents),
          JSON.stringify([coachIds[spec.coach]!]),
          spec.window?.[0] ?? null,
          spec.window?.[1] ?? null,
        ).lastInsertRowid,
      )
    }
  }

  // Sessions are per-date. Seed the next Monday and Wednesday from today so
  // the sample gym always shows upcoming practices, never stale ones. They
  // arrive with every class gathered and no blocks: hitting Generate is
  // the point of the demo.
  const insertSession = db.prepare(
    'INSERT INTO sessions (name, date, start_time, end_time, column_count, is_sample) VALUES (?, ?, ?, ?, ?, 1)',
  )
  const insertPlacement = db.prepare(
    'INSERT INTO placements (session_id, class_id, column_index, start_min, end_min) VALUES (?, ?, ?, ?, ?)',
  )
  const today = todayIsoDate()
  const todayDow = dayOfWeekOf(today)
  const nextWeekday = (dow: number) => addDays(today, (dow - todayDow + 7) % 7)

  const windowOf = (name: string): [number, number] => {
    for (const program of programs) {
      const spec = program.classes.find((c) => c.name === name)
      if (spec) {
        const [start, end] = spec.window ?? program.window
        return [at(start), at(end)]
      }
    }
    throw new Error(`no window for ${name}`)
  }

  /** Same packing the server does when classes are gathered. */
  const buildSession = (name: string, date: string, names: string[]) => {
    const sessionId = Number(insertSession.run(name, date, '16:00', '20:00', 0).lastInsertRowid)
    const taken: { column: number; start: number; end: number }[] = []
    for (const className of names) {
      const [start, end] = windowOf(className)
      let column = 0
      while (taken.some((t) => t.column === column && start < t.end && t.start < end)) column++
      insertPlacement.run(sessionId, classIds[className]!, column, start, end)
      taken.push({ column, start, end })
    }
    db.prepare('UPDATE sessions SET column_count = ? WHERE id = ?').run(
      taken.reduce((max, t) => Math.max(max, t.column + 1), 0),
      sessionId,
    )
  }

  const everyClass = programs.flatMap((p) => p.classes.map((c) => c.name))
  buildSession('Monday Team Practice', nextWeekday(1), everyClass)
  // Wednesday is a lighter night: preschool and rec only.
  buildSession(
    'Wednesday Practice',
    nextWeekday(3),
    everyClass.filter((n) => !n.includes('Team') && !n.includes('Level')),
  )
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
      // Sessions cascade to placements and blocks; classes must go before
      // the programs they point at.
      for (const table of ['sessions', 'groups', 'programs', 'coaches', 'events']) {
        db.prepare(`DELETE FROM ${table} WHERE is_sample = 1`).run()
      }
    })
    res.status(204).end()
  })

  return router
}
