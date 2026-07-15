// Entity types shared between the server and the frontend.
//
// Naming note: the product term for a training group is "class" (renamed
// from "group" after user testing). SQLite storage keeps the original
// `groups` table / `group_id` column names — the server's row mappers
// translate — so deployed databases never needed a rename migration.

export interface GymEvent {
  id: number
  name: string
  /** Max classes that can use this event simultaneously; null = no limit. */
  capacity: number | null
  active: boolean
  /** Hex color (#RRGGBB) shown wherever the event appears. */
  color: string
  isSample: boolean
}

export interface Coach {
  id: number
  name: string
  /** Event ids this coach can coach. */
  specialties: number[]
  /** Days of week (0 = Sunday … 6 = Saturday) this coach works. */
  availability: number[]
  isSample: boolean
}

export interface RequiredEvent {
  eventId: number
  /** Minutes; a multiple of the session's rotationLength. */
  duration: number
}

export interface GymClass {
  id: number
  name: string
  /** Higher priority wins when conflicts arise. */
  priority: number
  requiredEvents: RequiredEvent[]
  /** Coach ids who travel with this class. */
  assignedCoaches: number[]
  isSample: boolean
}

export interface Session {
  id: number
  name: string
  /**
   * The specific calendar day ("YYYY-MM-DD") this session happens —
   * sessions are per-date, not weekly slots; copy a session to repeat it.
   */
  date: string
  /** "HH:MM" 24h */
  startTime: string
  /** "HH:MM" 24h */
  endTime: string
  /** Slot granularity in minutes. */
  rotationLength: number
  /** Class ids attending this session. */
  classes: number[]
  /** Coaches marked absent for this session only (day-of change). */
  absentCoaches: number[]
  /** Events marked out for this session only (day-of change). */
  unavailableEvents: number[]
  isSample: boolean
}

/** One cell of a schedule: a class at an event during one time slot. */
export interface Assignment {
  slotIndex: number
  eventId: number
  classId: number
  coachId: number | null
  /** Locked cells survive regeneration; the solver plans around them. */
  locked?: boolean
}

/** Whether coaches travel with their class or own an event. */
export type CoachMode = 'class' | 'event'

/** "Avoid `beforeEventId` immediately before `afterEventId` for a class." */
export interface AdjacencyPenalty {
  beforeEventId: number
  afterEventId: number
}

export interface Settings {
  coachMode: CoachMode
  /** Configured bad back-to-back event pairs the solver tries to avoid. */
  adjacencyPenalties: AdjacencyPenalty[]
}

export interface User {
  id: number
  username: string
}

export interface MeResponse {
  setupNeeded: boolean
  user: User | null
}
