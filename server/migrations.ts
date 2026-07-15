import type { DatabaseSync } from 'node:sqlite'
import { EVENT_PALETTE } from '../shared/colors.ts'

// Schema changes are append-only migrations tracked via PRAGMA user_version.
// NEVER edit an existing migration — deployed databases have already run it.
// Add a new one to the end of the list instead.

interface Migration {
  name: string
  up: (db: DatabaseSync) => void
  /**
   * The migration manages its own transaction. Needed when it must toggle
   * `PRAGMA foreign_keys`, which is a no-op inside a transaction (the
   * standard SQLite table-rebuild procedure).
   */
  ownTransaction?: boolean
}

export const MIGRATIONS: Migration[] = [
  {
    name: 'initial-schema',
    up: (db) => {
      // IF NOT EXISTS keeps this a no-op on databases created before the
      // migration system existed.
      db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  is_sample INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS coaches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  specialties TEXT NOT NULL DEFAULT '[]',
  availability TEXT NOT NULL DEFAULT '[]',
  is_sample INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  required_events TEXT NOT NULL DEFAULT '[]',
  assigned_coaches TEXT NOT NULL DEFAULT '[]',
  is_sample INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  day_of_week INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  rotation_length INTEGER NOT NULL DEFAULT 15,
  groups TEXT NOT NULL DEFAULT '[]',
  is_sample INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  slot_index INTEGER NOT NULL,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  coach_id INTEGER REFERENCES coaches(id) ON DELETE SET NULL,
  UNIQUE(session_id, slot_index, event_id, group_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`)
    },
  },
  {
    name: 'event-colors',
    up: (db) => {
      db.exec("ALTER TABLE events ADD COLUMN color TEXT NOT NULL DEFAULT ''")
      // Backfill existing events (including previously seeded example-gym
      // rows) with palette colors, in creation order.
      const rows = db.prepare('SELECT id FROM events ORDER BY id').all() as { id: number }[]
      const update = db.prepare('UPDATE events SET color = ? WHERE id = ?')
      rows.forEach((row, index) => {
        update.run(EVENT_PALETTE[index % EVENT_PALETTE.length]!, row.id)
      })
    },
  },
  {
    name: 'assignment-locks',
    up: (db) => {
      db.exec('ALTER TABLE assignments ADD COLUMN locked INTEGER NOT NULL DEFAULT 0')
    },
  },
  {
    name: 'session-outages',
    up: (db) => {
      // Day-of, session-scoped outages — distinct from deactivating an
      // event globally or removing a coach.
      db.exec("ALTER TABLE sessions ADD COLUMN absent_coaches TEXT NOT NULL DEFAULT '[]'")
      db.exec("ALTER TABLE sessions ADD COLUMN unavailable_events TEXT NOT NULL DEFAULT '[]'")
    },
  },
  {
    // Capacity becomes optional: NULL means "no limit on simultaneous
    // classes". Existing events keep their configured limits — before this
    // migration every event had one. SQLite can't drop NOT NULL in place,
    // so this is the standard table rebuild, done with foreign keys off so
    // dropping the old table can't cascade into assignments.
    name: 'optional-event-capacity',
    ownTransaction: true,
    up: (db) => {
      db.exec('PRAGMA foreign_keys = OFF')
      db.exec('BEGIN')
      try {
        db.exec(`
CREATE TABLE events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  capacity INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  is_sample INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT ''
);
INSERT INTO events_new (id, name, capacity, active, is_sample, color)
  SELECT id, name, capacity, active, is_sample, color FROM events;
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;
`)
        const broken = db.prepare('PRAGMA foreign_key_check').all()
        if (broken.length > 0) {
          throw new Error(`optional-event-capacity broke foreign keys: ${JSON.stringify(broken)}`)
        }
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      } finally {
        db.exec('PRAGMA foreign_keys = ON')
      }
    },
  },
]

export function runMigrations(db: DatabaseSync, upTo: number = MIGRATIONS.length): void {
  const { user_version: applied } = db.prepare('PRAGMA user_version').get() as {
    user_version: number
  }
  for (let i = applied; i < upTo; i++) {
    const migration = MIGRATIONS[i]!
    if (migration.ownTransaction) {
      // The migration commits (or rolls back) itself; record the version
      // after it succeeds. If the process dies in between, the migration
      // reruns — rebuild-style migrations are safe to rerun.
      migration.up(db)
      db.exec(`PRAGMA user_version = ${i + 1}`)
      continue
    }
    db.exec('BEGIN')
    try {
      migration.up(db)
      db.exec(`PRAGMA user_version = ${i + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}
