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

    runMigrations(db)

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

    runMigrations(db)

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

    runMigrations(db)

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
})
