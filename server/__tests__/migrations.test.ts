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
