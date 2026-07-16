import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, runMigrations } from '../migrations.ts'
import { openDb } from '../db.ts'
import { EVENT_PALETTE, isHexColor } from '../../shared/colors.ts'
import { addDays, dayOfWeekOf, isIsoDate, todayIsoDate } from '../../shared/dates.ts'

describe('migration runner', () => {
  it('applies all migrations to a fresh database and records the version', () => {
    const db = openDb(':memory:')
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
      user_version: number
    }
    expect(version).toBe(MIGRATIONS.length)
    // color column exists and is usable
    db.prepare("INSERT INTO events (name, color) VALUES ('Beam', '#4E79A7')").run()
  })

  it('is idempotent', () => {
    const db = openDb(':memory:')
    expect(() => runMigrations(db)).not.toThrow()
  })

  it('backfills palette colors on a legacy database with existing events', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    // Simulate a deployment that stopped at the initial schema.
    runMigrations(db, 1)
    db.prepare("INSERT INTO events (name) VALUES ('Vault')").run()
    db.prepare("INSERT INTO events (name) VALUES ('Beam')").run()

    runMigrations(db)

    const rows = db.prepare('SELECT color FROM events ORDER BY id').all() as { color: string }[]
    expect(rows).toHaveLength(2)
    expect(rows[0]!.color).toBe(EVENT_PALETTE[0])
    expect(rows[1]!.color).toBe(EVENT_PALETTE[1])
    expect(rows.every((r) => isHexColor(r.color))).toBe(true)
  })

  it('makes capacity nullable while keeping existing limits and assignments', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    // Simulate a deployment from before optional capacities, with data that
    // exercises the assignments → events foreign key. Stops at the capacity
    // migration: the lane model later supersedes assignments entirely.
    runMigrations(db, 4)
    db.prepare("INSERT INTO events (name, capacity, color) VALUES ('Vault', 2, '#4E79A7')").run()
    db.prepare("INSERT INTO groups (name) VALUES ('L3')").run()
    db.prepare(
      "INSERT INTO sessions (day_of_week, start_time, end_time) VALUES (1, '16:00', '18:00')",
    ).run()
    db.prepare(
      'INSERT INTO assignments (session_id, slot_index, event_id, group_id) VALUES (1, 0, 1, 1)',
    ).run()

    runMigrations(db, 5)

    // Existing events keep their limits; the rebuild must not cascade into
    // assignments.
    expect(db.prepare('SELECT capacity FROM events WHERE id = 1').get()).toMatchObject({
      capacity: 2,
    })
    expect(db.prepare('SELECT COUNT(*) AS n FROM assignments').get()).toMatchObject({ n: 1 })

    // NULL capacity (no limit) is now storable; omitting it defaults to NULL.
    db.prepare("INSERT INTO events (name, color) VALUES ('Open Gym', '#59A14F')").run()
    expect(db.prepare("SELECT capacity FROM events WHERE name = 'Open Gym'").get()).toMatchObject({
      capacity: null,
    })

    // Foreign keys are enforced again after the rebuild.
    expect(() =>
      db
        .prepare('INSERT INTO assignments (session_id, slot_index, event_id, group_id) VALUES (1, 1, 99, 1)')
        .run(),
    ).toThrow(/FOREIGN KEY/)
  })

  it('adds the locked column defaulting to unlocked', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    // Stop before the lane model, which supersedes per-slot assignments.
    runMigrations(db, 4)
    db.prepare('INSERT INTO events (name, color) VALUES (?, ?)').run('Vault', '#4E79A7')
    db.prepare('INSERT INTO groups (name) VALUES (?)').run('L3')
    db.prepare(
      "INSERT INTO sessions (day_of_week, start_time, end_time) VALUES (1, '16:00', '18:00')",
    ).run()
    db.prepare(
      'INSERT INTO assignments (session_id, slot_index, event_id, group_id) VALUES (1, 0, 1, 1)',
    ).run()
    const row = db.prepare('SELECT locked FROM assignments').get() as { locked: number }
    expect(row.locked).toBe(0)
  })

  it('backfills session dates from day_of_week, keeping the weekday and looking forward', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    // A deployment from before sessions carried dates.
    runMigrations(db, 5)
    const insert = db.prepare(
      "INSERT INTO sessions (name, day_of_week, start_time, end_time) VALUES (?, ?, '16:00', '18:00')",
    )
    for (let dow = 0; dow <= 6; dow++) insert.run(`Session ${dow}`, dow)

    // Stop at session-dates; a later migration reverts to weekday slots.
    runMigrations(db, 6)

    const columns = (
      db.prepare("SELECT name FROM pragma_table_info('sessions')").all() as { name: string }[]
    ).map((c) => c.name)
    expect(columns).toContain('date')
    expect(columns).not.toContain('day_of_week')

    const sessions = db.prepare('SELECT name, date FROM sessions ORDER BY id').all() as {
      name: string
      date: string
    }[]
    const today = todayIsoDate()
    for (const [dow, session] of sessions.entries()) {
      // Every session lands on its original weekday, today or later, and
      // within the coming week.
      expect(isIsoDate(session.date)).toBe(true)
      expect(dayOfWeekOf(session.date)).toBe(dow)
      expect(session.date >= today).toBe(true)
      expect(session.date <= addDays(today, 6)).toBe(true)
    }
  })

  it('converts the old grid to lanes: a full-window column per class', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    // A deployment from just before the lane model.
    runMigrations(db, 6)
    db.prepare("INSERT INTO events (name, color) VALUES ('Vault', '#4E79A7')").run()
    db.prepare("INSERT INTO events (name, color) VALUES ('Beam', '#59A14F')").run()
    db.prepare("INSERT INTO coaches (name) VALUES ('Dana Marsh')").run()
    db.prepare("INSERT INTO groups (name) VALUES ('L3')").run()
    db.prepare("INSERT INTO groups (name) VALUES ('L5')").run()
    db.prepare(
      `INSERT INTO sessions (name, date, start_time, end_time, rotation_length, groups)
       VALUES ('Monday', '2026-03-02', '16:00', '18:00', 15, '[1,2]')`,
    ).run()
    const insert = db.prepare(
      'INSERT INTO assignments (session_id, slot_index, event_id, group_id, coach_id, locked) VALUES (1, ?, ?, ?, ?, ?)',
    )
    // L3: two 15-min slots on Vault with the same coach (one 30-min block),
    // then one on Beam. A gap at slot 3, then Vault again — which must NOT
    // merge with the earlier Vault run.
    insert.run(0, 1, 1, 1, 0)
    insert.run(1, 1, 1, 1, 0)
    insert.run(2, 2, 1, null, 1)
    insert.run(4, 1, 1, 1, 0)
    // L5: a single locked slot.
    insert.run(0, 2, 2, null, 1)

    // Stop at the lane model — the migration under test here.
    runMigrations(db, 7)

    // Old storage is gone; attendance and granularity now live in the grid.
    const sessionColumns = (
      db.prepare("SELECT name FROM pragma_table_info('sessions')").all() as { name: string }[]
    ).map((c) => c.name)
    expect(sessionColumns).toContain('column_count')
    expect(sessionColumns).not.toContain('groups')
    expect(sessionColumns).not.toContain('rotation_length')
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'assignments'").all(),
    ).toHaveLength(0)

    // Each class became a full-window placement in its own column.
    const placements = db
      .prepare('SELECT id, class_id, column_index, start_min, end_min FROM placements ORDER BY column_index')
      .all() as {
      id: number
      class_id: number
      column_index: number
      start_min: number
      end_min: number
    }[]
    expect(placements).toMatchObject([
      { class_id: 1, column_index: 0, start_min: 960, end_min: 1080 },
      { class_id: 2, column_index: 1, start_min: 960, end_min: 1080 },
    ])
    expect(db.prepare('SELECT column_count FROM sessions').get()).toMatchObject({
      column_count: 2,
    })

    // L3's slots merged into blocks by event+coach, but the gap kept the
    // two Vault runs apart rather than fusing them into one long block.
    const l3 = db
      .prepare(
        'SELECT event_id, coach_id, start_min, end_min, locked FROM event_blocks WHERE placement_id = ? ORDER BY start_min',
      )
      .all(placements[0]!.id)
    expect(l3).toEqual([
      { event_id: 1, coach_id: 1, start_min: 960, end_min: 990, locked: 0 },
      { event_id: 2, coach_id: null, start_min: 990, end_min: 1005, locked: 1 },
      { event_id: 1, coach_id: 1, start_min: 1020, end_min: 1035, locked: 0 },
    ])

    // Locks survive the conversion.
    const l5 = db
      .prepare('SELECT event_id, start_min, end_min, locked FROM event_blocks WHERE placement_id = ?')
      .all(placements[1]!.id)
    expect(l5).toEqual([{ event_id: 2, start_min: 960, end_min: 975, locked: 1 }])

    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('keeps work from a class dropped off the session list, and skips deleted ones', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    runMigrations(db, 6)
    db.prepare("INSERT INTO events (name, color) VALUES ('Vault', '#4E79A7')").run()
    db.prepare("INSERT INTO groups (name) VALUES ('Still here')").run()
    // groups lists a class that no longer exists (id 99) plus one real one;
    // a second real class holds cells without being on the list.
    db.prepare("INSERT INTO groups (name) VALUES ('Off the list')").run()
    db.prepare(
      `INSERT INTO sessions (name, date, start_time, end_time, rotation_length, groups)
       VALUES ('Monday', '2026-03-02', '16:00', '18:00', 15, '[1,99]')`,
    ).run()
    db.prepare(
      'INSERT INTO assignments (session_id, slot_index, event_id, group_id) VALUES (1, 0, 1, 2)',
    ).run()

    // Stop at the lane model — the migration under test here.
    runMigrations(db, 7)

    const placements = db
      .prepare('SELECT class_id, column_index FROM placements ORDER BY column_index')
      .all()
    // The deleted class is dropped; the one holding cells is rescued.
    expect(placements).toEqual([
      { class_id: 1, column_index: 0 },
      { class_id: 2, column_index: 1 },
    ])
    expect(db.prepare('SELECT COUNT(*) AS n FROM event_blocks').get()).toMatchObject({ n: 1 })
  })

  it('puts existing classes under a General program', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    // A deployment from just before programs existed. Stop at the programs
    // migration so we can observe it before rotation-plans reshapes classes.
    runMigrations(db, 7)
    db.prepare("INSERT INTO events (name, color) VALUES ('Vault', '#4E79A7')").run()
    db.prepare("INSERT INTO events (name, color) VALUES ('Beam', '#59A14F')").run()
    db.prepare(
      `INSERT INTO groups (name, required_events) VALUES
       ('Level 3', '[{"eventId":1,"duration":30},{"eventId":2,"duration":15}]')`,
    ).run()
    db.prepare("INSERT INTO groups (name, required_events) VALUES ('Boys Team', '[]')").run()

    runMigrations(db, 8)

    // One catch-all program, and every class is in it: a gym that never had
    // programs had exactly one.
    const programs = db.prepare('SELECT id, name, default_start_time FROM programs').all()
    expect(programs).toEqual([{ id: 1, name: 'General', default_start_time: null }])
    const classes = db.prepare('SELECT name, program_id FROM groups ORDER BY id').all()
    expect(classes).toEqual([
      { name: 'Level 3', program_id: 1 },
      { name: 'Boys Team', program_id: 1 },
    ])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('rotation-plans converts events and required-events to the 4-week model', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    // A deployment from just before the 4-week plan model.
    runMigrations(db, 8)
    db.prepare("INSERT INTO programs (name) VALUES ('General')").run()
    // Vault held for one length, an exclusive (limit 1) apparatus; Stretch a
    // shared (no-limit) cool-down.
    db.prepare("INSERT INTO events (name, capacity, color) VALUES ('Vault', 1, '#4E79A7')").run()
    db.prepare("INSERT INTO events (name, capacity, color) VALUES ('Stretch', NULL, '#59A14F')").run()
    // A class with a FIRST warm-up (Vault, oddly), a middle event, and a LAST
    // cool-down — the three shapes the backfill has to place.
    db.prepare(
      `INSERT INTO groups (name, program_id, required_events) VALUES
       ('Level 3', 1,
        '[{"eventId":1,"duration":10,"position":"FIRST"},{"eventId":2,"duration":15,"position":"ANY"},{"eventId":2,"duration":10,"position":"LAST"}]')`,
    ).run()
    db.prepare(
      "INSERT INTO groups (name, program_id, required_events) VALUES ('Empty', 1, '[]')",
    ).run()
    db.prepare(
      `INSERT INTO sessions (name, date, start_time, end_time, column_count)
       VALUES ('Monday', '2026-03-02', '16:00', '18:00', 1)`,
    ).run()
    db.prepare(
      'INSERT INTO placements (session_id, class_id, column_index, start_min, end_min) VALUES (1, 1, 0, 960, 1080)',
    ).run()

    // Stop at rotation-plans — the migration under test here.
    runMigrations(db, 9)

    // Events gain a duration (seeded from the shortest length seen) and a
    // shared flag mirrored from capacity.
    const events = db
      .prepare('SELECT name, duration_minutes AS d, shared, capacity FROM events ORDER BY id')
      .all()
    expect(events).toEqual([
      { name: 'Vault', d: 10, shared: 0, capacity: 1 },
      // Stretch was never in a required list, so it keeps the default 10.
      { name: 'Stretch', d: 10, shared: 1, capacity: null },
    ])

    // required_events is gone, converted to eligibility + anchors. FIRST →
    // warm-up, LAST → cool-down, ANY → eligible; period is the sum of lengths.
    expect(
      db.prepare("SELECT name FROM pragma_table_info('groups')").all() as { name: string }[],
    ).not.toContainEqual({ name: 'required_events' })
    const l3 = db
      .prepare(
        `SELECT eligible_events AS eligible, period_minutes AS period, warmup_event_id AS w,
                warmup_minutes AS wm, cooldown_event_id AS c, cooldown_minutes AS cm
         FROM groups WHERE id = 1`,
      )
      .get() as Record<string, unknown>
    expect(l3).toEqual({
      eligible: '[2]',
      period: 35, // 10 + 15 + 10
      w: 1,
      wm: 10,
      c: 2,
      cm: 10,
    })
    // A class with no required events falls back to a 45-minute period.
    expect(db.prepare('SELECT period_minutes AS p FROM groups WHERE id = 2').get()).toMatchObject({
      p: 45,
    })

    // Sessions gain plan scaffolding and existing placements become week 1.
    expect(db.prepare('SELECT week_locks AS wl, plan_warnings AS pw FROM sessions').get()).toEqual({
      wl: '[false,false,false,false]',
      pw: '[]',
    })
    expect(db.prepare('SELECT week FROM placements').get()).toMatchObject({ week: 1 })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('does not invent a program for a gym that has no classes', () => {
    const db = openDb(':memory:')
    expect(db.prepare('SELECT COUNT(*) AS n FROM programs').get()).toMatchObject({ n: 0 })
  })

  it('class-owned-schedule derives class weekdays/time and turns sessions into slots', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    // A deployment on the dated-session model, just before classes owned time.
    runMigrations(db, 9)
    db.prepare("INSERT INTO programs (name) VALUES ('General')").run()
    db.prepare(
      "INSERT INTO groups (name, program_id, period_minutes) VALUES ('LWM', 1, 45)",
    ).run()
    // The class was placed in a Monday and a Wednesday session, both at 16:00.
    db.prepare(
      `INSERT INTO sessions (name, date, start_time, end_time, column_count)
       VALUES ('Mon', '2026-03-02', '16:00', '17:00', 1), ('Wed', '2026-03-04', '16:00', '17:00', 1)`,
    ).run()
    db.prepare(
      `INSERT INTO placements (session_id, class_id, column_index, week, start_min, end_min)
       VALUES (1, 1, 0, 1, 960, 1020), (2, 1, 0, 1, 960, 1020)`,
    ).run()

    runMigrations(db)

    // The class now owns its schedule: it meets Monday and Wednesday at 16:00.
    const cls = db
      .prepare('SELECT days_of_week AS d, start_time AS t FROM groups WHERE id = 1')
      .get() as { d: string; t: string }
    expect(JSON.parse(cls.d)).toEqual([1, 3])
    expect(cls.t).toBe('16:00')

    // Sessions carry the weekday and have shed the calendar date.
    const cols = (
      db.prepare("SELECT name FROM pragma_table_info('sessions')").all() as { name: string }[]
    ).map((c) => c.name)
    expect(cols).toContain('day_of_week')
    expect(cols).not.toContain('date')
    expect(
      (db.prepare('SELECT day_of_week AS d FROM sessions ORDER BY id').all() as { d: number }[]).map(
        (r) => r.d,
      ),
    ).toEqual([1, 3])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})
