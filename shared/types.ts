// Entity types shared between the server and the frontend.

export interface GymEvent {
  id: number
  name: string
  capacity: number
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

export interface Group {
  id: number
  name: string
  /** Higher priority wins when conflicts arise. */
  priority: number
  requiredEvents: RequiredEvent[]
  /** Coach ids who travel with this group. */
  assignedCoaches: number[]
  isSample: boolean
}

export interface Session {
  id: number
  name: string
  /** 0 = Sunday … 6 = Saturday */
  dayOfWeek: number
  /** "HH:MM" 24h */
  startTime: string
  /** "HH:MM" 24h */
  endTime: string
  /** Slot granularity in minutes. */
  rotationLength: number
  /** Group ids attending this session. */
  groups: number[]
  /** Coaches marked absent for this session only (day-of change). */
  absentCoaches: number[]
  /** Events marked out for this session only (day-of change). */
  unavailableEvents: number[]
  isSample: boolean
}

/** One cell of a schedule: a group at an event during one time slot. */
export interface Assignment {
  slotIndex: number
  eventId: number
  groupId: number
  coachId: number | null
  /** Locked cells survive regeneration; the solver plans around them. */
  locked?: boolean
}

/** Whether coaches travel with their group or own an event. */
export type CoachMode = 'group' | 'event'

/** "Avoid `beforeEventId` immediately before `afterEventId` for a group." */
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
