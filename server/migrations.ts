import type { DatabaseSync } from 'node:sqlite'
import { EVENT_PALETTE } from '../shared/colors.ts'
import { addDays, dayOfWeekOf, todayIsoDate } from '../shared/dates.ts'
import { parseTime } from '../shared/slots.ts'

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
  {
    // Sessions become calendar-specific: a concrete date ("YYYY-MM-DD")
    // replaces the generic weekly day_of_week. Existing sessions are
    // backfilled with the next occurrence of their weekday (counting
    // today), which keeps them upcoming and on the right day.
    name: 'session-dates',
    up: (db) => {
      db.exec("ALTER TABLE sessions ADD COLUMN date TEXT NOT NULL DEFAULT ''")
      const rows = db.prepare('SELECT id, day_of_week FROM sessions').all() as {
        id: number
        day_of_week: number
      }[]
      const today = todayIsoDate()
      const todayDow = dayOfWeekOf(today)
      const update = db.prepare('UPDATE sessions SET date = ? WHERE id = ?')
      for (const row of rows) {
        update.run(addDays(today, (row.day_of_week - todayDow + 7) % 7), row.id)
      }
      db.exec('ALTER TABLE sessions DROP COLUMN day_of_week')
    },
  },
  {
    // The lane model. A session's grid becomes columns; each column holds a
    // vertical sequence of class placements, each with its own window; each
    // placement holds explicit event blocks.
    //
    // Converting the old model: every class that attended a session becomes
    // a full-window placement in its own column (the old grid effectively
    // ran every class for the whole session), and its per-slot assignments
    // become blocks — consecutive slots on the same event and coach merge
    // into one block, which is exactly how the old grid already rendered
    // and exported them.
    name: 'lane-model',
    up: (db) => {
      db.exec(`
CREATE TABLE placements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  column_index INTEGER NOT NULL,
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL
);

CREATE TABLE event_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  placement_id INTEGER NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  coach_id INTEGER REFERENCES coaches(id) ON DELETE SET NULL,
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_placements_session ON placements(session_id);
CREATE INDEX idx_blocks_placement ON event_blocks(placement_id);
`)
      db.exec('ALTER TABLE sessions ADD COLUMN column_count INTEGER NOT NULL DEFAULT 0')

      const sessions = db
        .prepare('SELECT id, start_time, end_time, rotation_length, groups FROM sessions')
        .all() as {
        id: number
        start_time: string
        end_time: string
        rotation_length: number
        groups: string
      }[]
      const insertPlacement = db.prepare(
        'INSERT INTO placements (session_id, class_id, column_index, start_min, end_min) VALUES (?, ?, ?, ?, ?)',
      )
      const insertBlock = db.prepare(
        'INSERT INTO event_blocks (placement_id, event_id, coach_id, start_min, end_min, locked) VALUES (?, ?, ?, ?, ?, ?)',
      )
      const setColumnCount = db.prepare('UPDATE sessions SET column_count = ? WHERE id = ?')
      const classExists = db.prepare('SELECT 1 AS x FROM groups WHERE id = ?')

      for (const session of sessions) {
        const startMin = parseTime(session.start_time) ?? 0
        const endMin = parseTime(session.end_time) ?? startMin
        // A class only becomes a placement if it still exists — older rows
        // could reference a since-deleted class.
        const classIds = (JSON.parse(session.groups) as number[]).filter((id) =>
          classExists.get(id),
        )
        // Assignments may also name classes that were dropped from the
        // session's list but still hold cells; keep their work.
        const assigned = db
          .prepare(
            'SELECT DISTINCT group_id FROM assignments WHERE session_id = ? ORDER BY group_id',
          )
          .all(session.id) as { group_id: number }[]
        for (const row of assigned) {
          if (!classIds.includes(row.group_id) && classExists.get(row.group_id)) {
            classIds.push(row.group_id)
          }
        }

        classIds.forEach((classId, index) => {
          const placementId = Number(
            insertPlacement.run(session.id, classId, index, startMin, endMin).lastInsertRowid,
          )
          // Merge consecutive same-event, same-coach slots into blocks.
          const cells = db
            .prepare(
              'SELECT slot_index, event_id, coach_id, locked FROM assignments WHERE session_id = ? AND group_id = ? ORDER BY slot_index',
            )
            .all(session.id, classId) as {
            slot_index: number
            event_id: number
            coach_id: number | null
            locked: number
          }[]
          let run: {
            eventId: number
            coachId: number | null
            locked: number
            startMin: number
            endMin: number
          } | null = null
          const flush = () => {
            if (run) insertBlock.run(placementId, run.eventId, run.coachId, run.startMin, run.endMin, run.locked)
            run = null
          }
          for (const cell of cells) {
            const cellStart = startMin + cell.slot_index * session.rotation_length
            const cellEnd = cellStart + session.rotation_length
            if (
              run &&
              run.eventId === cell.event_id &&
              run.coachId === cell.coach_id &&
              run.locked === cell.locked &&
              run.endMin === cellStart
            ) {
              run.endMin = cellEnd
              continue
            }
            flush()
            run = {
              eventId: cell.event_id,
              coachId: cell.coach_id,
              locked: cell.locked,
              startMin: cellStart,
              endMin: cellEnd,
            }
          }
          flush()
        })
        setColumnCount.run(classIds.length, session.id)
      }

      // Superseded: attendance is now expressed by placements, the grid is
      // always 5-minute rows, and cells are now blocks.
      db.exec('DROP TABLE assignments')
      db.exec('ALTER TABLE sessions DROP COLUMN groups')
      db.exec('ALTER TABLE sessions DROP COLUMN rotation_length')
    },
  },
  {
    // The program layer. A gym's structure — programs, their classes, and
    // each class's events with per-class durations and position anchors —
    // becomes the input that generation works from, so it needs somewhere
    // to live.
    //
    // Existing classes all land under one "General" program, which is
    // truthful: a gym that never had programs had exactly one. Existing
    // required events become position ANY, which is what they meant when
    // order was unconstrained.
    name: 'programs',
    up: (db) => {
      db.exec(`
CREATE TABLE programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  default_start_time TEXT,
  default_end_time TEXT,
  is_sample INTEGER NOT NULL DEFAULT 0
);
`)
      // program_id stays nullable: SQLite cannot add a NOT NULL foreign key
      // to an existing table without a full rebuild, and the API requires a
      // real program anyway. Deleting a program is refused while it still
      // has classes, so this never goes null behind the user's back.
      db.exec('ALTER TABLE groups ADD COLUMN program_id INTEGER REFERENCES programs(id)')
      db.exec('ALTER TABLE groups ADD COLUMN default_start_time TEXT')
      db.exec('ALTER TABLE groups ADD COLUMN default_end_time TEXT')

      const classes = db.prepare('SELECT id, required_events FROM groups').all() as {
        id: number
        required_events: string
      }[]
      if (classes.length > 0) {
        // Only make the catch-all program if there are classes to put in it;
        // a fresh database should not start with a phantom program.
        const programId = Number(
          db
            .prepare("INSERT INTO programs (name, is_sample) VALUES ('General', 0)")
            .run().lastInsertRowid,
        )
        db.prepare('UPDATE groups SET program_id = ?').run(programId)
      }

      const update = db.prepare('UPDATE groups SET required_events = ? WHERE id = ?')
      for (const row of classes) {
        const entries = JSON.parse(row.required_events) as {
          eventId: number
          duration: number
          position?: string
        }[]
        update.run(
          JSON.stringify(entries.map((e) => ({ ...e, position: e.position ?? 'ANY' }))),
          row.id,
        )
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
