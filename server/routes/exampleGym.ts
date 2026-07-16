import { Router } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import { ApiError } from '../validate.ts'
import { withTransaction } from '../tx.ts'
import { EVENT_PALETTE } from '../../shared/colors.ts'
import { addDays, dayOfWeekOf, todayIsoDate } from '../../shared/dates.ts'
import { parseTime } from '../../shared/slots.ts'
import { PLAN_WEEKS } from '../../shared/types.ts'

// Clearly fictional sample data so a new gym can explore before entering its
// own. Every row is is_sample so it can be removed in one click.
//
// Built to demonstrate the whole 4-week model rather than to look tidy:
// - shared events (Warm-up, Stretch, Conditioning) that many classes use at
//   once, and exclusive apparatus that only one class may use at a time;
// - a Tumble Trak that classes from *different programs* are all eligible
//   for and must contend over — the point of the generator;
// - varied per-event durations and per-class period/warm-up/cool-down.
// It ships with classes gathered and nothing generated: pressing Generate
// produces the 4-week plan, which is the demo.

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
  periodMinutes: number
  warmup: [string, number] // [event, minutes]
  cooldown: [string, number]
  eligible: string[]
  coach: string
}

function seed(db: DatabaseSync): void {
  // --- Events: [name, durationPerVisit, shared?] ---
  const insertEvent = db.prepare(
    'INSERT INTO events (name, duration_minutes, shared, capacity, active, color, is_sample) VALUES (?, ?, ?, ?, 1, ?, 1)',
  )
  const eventIds: Record<string, number> = {}
  const sampleEvents: [string, number, boolean][] = [
    ['Warm-up', 10, true], // shared: everyone warms up together
    ['Tumble Trak', 15, false], // exclusive, contested across programs
    ['PS Vault', 10, false],
    ['PS Bars', 10, false],
    ['PS Floor', 10, false],
    ['Rec Beams', 10, false],
    ['Trampoline', 15, false],
    ['Conditioning', 10, true], // shared
    ['Stretch', 10, true], // shared: cool-down
  ]
  sampleEvents.forEach(([name, duration, shared], index) => {
    eventIds[name] = Number(
      insertEvent.run(
        name,
        duration,
        shared ? 1 : 0,
        shared ? null : 1,
        EVENT_PALETTE[index % EVENT_PALETTE.length]!,
      ).lastInsertRowid,
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
    `INSERT INTO groups (name, program_id, priority, eligible_events, period_minutes,
                         warmup_event_id, warmup_minutes, cooldown_event_id, cooldown_minutes,
                         assigned_coaches, is_sample)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  )
  const classIds: Record<string, number> = {}

  // All classes run the same 16:00–17:15 clock, so the exclusive Tumble Trak
  // is genuinely fought over. Preschool spends longer per event; Rec Gym
  // rotates faster and has more eligible apparatus than fit one period —
  // exactly what the 4-week coverage spread is for.
  const programs: { name: string; window: [string, string]; classes: ClassSpec[] }[] = [
    {
      name: 'Preschool',
      window: ['16:00', '17:15'],
      classes: [
        {
          name: 'Tiny Tot 1',
          priority: 0,
          periodMinutes: 60,
          warmup: ['Warm-up', 10],
          cooldown: ['Stretch', 10],
          eligible: ['Tumble Trak', 'PS Vault', 'PS Floor'],
          coach: 'Dana Marsh',
        },
        {
          name: 'Tiny Tot 2',
          priority: 0,
          periodMinutes: 60,
          warmup: ['Warm-up', 10],
          cooldown: ['Stretch', 10],
          eligible: ['Tumble Trak', 'PS Bars', 'PS Floor'],
          coach: 'Dana Marsh',
        },
      ],
    },
    {
      name: 'Rec Gym',
      window: ['16:00', '17:15'],
      classes: [
        {
          name: 'Rec Gym 1',
          priority: 1,
          periodMinutes: 60,
          warmup: ['Warm-up', 10],
          cooldown: ['Conditioning', 10],
          eligible: ['Tumble Trak', 'Rec Beams', 'PS Vault', 'Trampoline'],
          coach: 'Sam Ortiz',
        },
        {
          name: 'Rec Gym 2',
          priority: 1,
          periodMinutes: 60,
          warmup: ['Warm-up', 10],
          cooldown: ['Conditioning', 10],
          eligible: ['Tumble Trak', 'Rec Beams', 'PS Bars', 'Trampoline'],
          coach: 'Jules Baptiste',
        },
      ],
    },
  ]

  for (const program of programs) {
    const programId = Number(
      insertProgram.run(program.name, program.window[0], program.window[1]).lastInsertRowid,
    )
    for (const spec of program.classes) {
      classIds[spec.name] = Number(
        insertClass.run(
          spec.name,
          programId,
          spec.priority,
          JSON.stringify(spec.eligible.map((n) => eventIds[n]!)),
          spec.periodMinutes,
          eventIds[spec.warmup[0]]!,
          spec.warmup[1],
          eventIds[spec.cooldown[0]]!,
          spec.cooldown[1],
          JSON.stringify([coachIds[spec.coach]!]),
        ).lastInsertRowid,
      )
    }
  }

  // Sessions are per-date. Seed the next Monday and Wednesday. Each gathers
  // its classes onto the shared clock in weeks 1..PLAN_WEEKS, ungenerated.
  const insertSession = db.prepare(
    'INSERT INTO sessions (name, date, start_time, end_time, column_count, is_sample) VALUES (?, ?, ?, ?, ?, 1)',
  )
  const insertPlacement = db.prepare(
    'INSERT INTO placements (session_id, class_id, column_index, week, start_min, end_min) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const today = todayIsoDate()
  const todayDow = dayOfWeekOf(today)
  const nextWeekday = (dow: number) => addDays(today, (dow - todayDow + 7) % 7)

  const buildSession = (name: string, date: string, names: string[]) => {
    const start = at('16:00')
    const end = at('17:15')
    const sessionId = Number(
      insertSession.run(name, date, '16:00', '17:15', names.length).lastInsertRowid,
    )
    names.forEach((className, column) => {
      for (let week = 1; week <= PLAN_WEEKS; week++) {
        insertPlacement.run(sessionId, classIds[className]!, column, week, start, end)
      }
    })
  }

  const everyClass = Object.keys(classIds)
  buildSession('Monday Team Practice', nextWeekday(1), everyClass)
  buildSession('Wednesday Practice', nextWeekday(3), everyClass)
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
