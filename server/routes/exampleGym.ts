import { Router } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import { ApiError } from '../validate.ts'
import { withTransaction } from '../tx.ts'
import { EVENT_PALETTE } from '../../shared/colors.ts'
import { reconcileSessions } from './sessions.ts'

// Clearly fictional sample data so a new gym can explore before entering its
// own. Every row is is_sample so it can be removed in one click.
//
// Built to demonstrate the whole model rather than to look tidy:
// - shared events (Warm-up, Conditioning, Stretch) that many classes use at
//   once, and exclusive apparatus that only one class may use at a time;
// - a Tumble Trak that classes from *different programs* are all eligible for
//   and must contend over — the point of the generator;
// - classes that own their schedule: they meet Monday and Wednesday at 16:00,
//   so Salto auto-derives a "Monday 4:00 PM" and a "Wednesday 4:00 PM" slot,
//   each a repeating 4-week plan you generate.

function sampleLoaded(db: DatabaseSync): boolean {
  for (const table of ['events', 'coaches', 'groups', 'programs']) {
    const row = db.prepare(`SELECT 1 AS x FROM ${table} WHERE is_sample = 1 LIMIT 1`).get()
    if (row) return true
  }
  return false
}

interface ClassSpec {
  name: string
  priority: number
  daysOfWeek: number[]
  startTime: string
  periodMinutes: number
  warmup: [string, number] // [event, minutes]
  cooldown: [string, number]
  /** [event, minutes this class spends there per visit] */
  eligible: [string, number][]
  coach: string
}

function seed(db: DatabaseSync): void {
  // --- Events: [name, shared?]. Events have no duration; the class carries it. ---
  const insertEvent = db.prepare(
    'INSERT INTO events (name, shared, capacity, active, color, is_sample) VALUES (?, ?, ?, 1, ?, 1)',
  )
  const eventIds: Record<string, number> = {}
  const sampleEvents: [string, boolean][] = [
    ['Warm-up', true], // shared: everyone warms up together
    ['Tumble Trak', false], // exclusive, contested across programs
    ['PS Vault', false],
    ['PS Bars', false],
    ['PS Floor', false],
    ['Rec Beams', false],
    ['Trampoline', false],
    ['Conditioning', true], // shared
    ['Stretch', true], // shared: cool-down
  ]
  sampleEvents.forEach(([name, shared], index) => {
    eventIds[name] = Number(
      insertEvent.run(
        name,
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
    `INSERT INTO groups (name, program_id, priority, days_of_week, start_time, eligible_events,
                         period_minutes, warmup_event_id, warmup_minutes, cooldown_event_id,
                         cooldown_minutes, assigned_coaches, is_sample)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  )

  // Every class meets Monday and Wednesday at 16:00, so both slots pit all
  // four classes — across two programs — against the one Tumble Trak. Rec Gym
  // has more eligible apparatus than fits one 60-min period, which is exactly
  // what the 4-week coverage spread is for.
  const MON_WED = [1, 3]
  const programs: { name: string; window: [string, string]; classes: ClassSpec[] }[] = [
    {
      name: 'Preschool',
      window: ['16:00', '17:00'],
      classes: [
        {
          name: 'Tiny Tot 1',
          priority: 0,
          daysOfWeek: MON_WED,
          startTime: '16:00',
          periodMinutes: 60,
          warmup: ['Warm-up', 10],
          cooldown: ['Stretch', 10],
          eligible: [['Tumble Trak', 15], ['PS Vault', 10], ['PS Floor', 10]],
          coach: 'Dana Marsh',
        },
        {
          name: 'Tiny Tot 2',
          priority: 0,
          daysOfWeek: MON_WED,
          startTime: '16:00',
          periodMinutes: 60,
          warmup: ['Warm-up', 10],
          cooldown: ['Stretch', 10],
          eligible: [['Tumble Trak', 15], ['PS Bars', 10], ['PS Floor', 10]],
          coach: 'Dana Marsh',
        },
      ],
    },
    {
      name: 'Rec Gym',
      window: ['16:00', '17:00'],
      classes: [
        {
          name: 'Rec Gym 1',
          priority: 1,
          daysOfWeek: MON_WED,
          startTime: '16:00',
          periodMinutes: 60,
          warmup: ['Warm-up', 10],
          cooldown: ['Conditioning', 10],
          eligible: [['Tumble Trak', 15], ['Rec Beams', 10], ['PS Vault', 10], ['Trampoline', 15]],
          coach: 'Sam Ortiz',
        },
        {
          name: 'Rec Gym 2',
          priority: 1,
          daysOfWeek: MON_WED,
          startTime: '16:00',
          periodMinutes: 60,
          warmup: ['Warm-up', 10],
          cooldown: ['Conditioning', 10],
          eligible: [['Tumble Trak', 15], ['Rec Beams', 10], ['PS Bars', 10], ['Trampoline', 15]],
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
      insertClass.run(
        spec.name,
        programId,
        spec.priority,
        JSON.stringify(spec.daysOfWeek),
        spec.startTime,
        JSON.stringify(spec.eligible.map(([n, m]) => ({ eventId: eventIds[n]!, minutes: m }))),
        spec.periodMinutes,
        eventIds[spec.warmup[0]]!,
        spec.warmup[1],
        eventIds[spec.cooldown[0]]!,
        spec.cooldown[1],
        JSON.stringify([coachIds[spec.coach]!]),
      )
    }
  }
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
    // The Monday/Wednesday 16:00 slots fall out of the classes' schedules.
    reconcileSessions(db)
    res.status(201).json({ loaded: true })
  })

  router.delete('/example-gym', (_req, res) => {
    withTransaction(db, () => {
      // Classes must go before the programs they point at. Deleting the sample
      // classes cascades their placements; reconciliation then drops the
      // now-empty derived slots.
      for (const table of ['groups', 'programs', 'coaches', 'events']) {
        db.prepare(`DELETE FROM ${table} WHERE is_sample = 1`).run()
      }
    })
    reconcileSessions(db)
    res.status(204).end()
  })

  return router
}
