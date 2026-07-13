import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from './migrations.ts'

export function openDb(location: string): DatabaseSync {
  if (location !== ':memory:') {
    fs.mkdirSync(path.dirname(location), { recursive: true })
  }
  const db = new DatabaseSync(location)
  if (location !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL')
  }
  db.exec('PRAGMA foreign_keys = ON')
  runMigrations(db)
  return db
}
