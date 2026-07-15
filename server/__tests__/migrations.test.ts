import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, runMigrations } from '../migrations.ts'
import { openDb } from '../db.ts'
import { EVENT_PALETTE, isHexColor } from '../../shared/colors.ts'

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
    // exercises the assignments → events foreign key.
    runMigrations(db, 4)
    db.prepare("INSERT INTO events (name, capacity, color) VALUES ('Vault', 2, '#4E79A7')").run()
    db.prepare("INSERT INTO groups (name) VALUES ('L3')").run()
    db.prepare(
      "INSERT INTO sessions (day_of_week, start_time, end_time) VALUES (1, '16:00', '18:00')",
    ).run()
    db.prepare(
      'INSERT INTO assignments (session_id, slot_index, event_id, group_id) VALUES (1, 0, 1, 1)',
    ).run()

    runMigrations(db)

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
    const db = openDb(':memory:')
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
})
