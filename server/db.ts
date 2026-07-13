import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
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
`

export function openDb(location: string): DatabaseSync {
  if (location !== ':memory:') {
    fs.mkdirSync(path.dirname(location), { recursive: true })
  }
  const db = new DatabaseSync(location)
  if (location !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL')
  }
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}
