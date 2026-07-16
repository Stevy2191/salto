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

/**
 * Where an event sits in a class's order.
 * - FIRST: the class starts with it (a warm-up)
 * - LAST: the class ends with it (a cool-down)
 * - ANY: free to fall anywhere between
 *
 * A position anchors the *order*, not the clock: a warm-up is the first
 * thing the class does, not something pinned to the minute its window opens.
 * Pinning would make good schedules impossible as soon as two classes wanted
 * the same warm-up apparatus — which a shared Tumble Trak causes at once.
 */
export type EventPosition = 'FIRST' | 'LAST' | 'ANY'

export const EVENT_POSITIONS: EventPosition[] = ['FIRST', 'ANY', 'LAST']

export interface RequiredEvent {
  eventId: number
  /** Minutes; a multiple of SLOT_MINUTES. Per class, never global. */
  duration: number
  position: EventPosition
}

/**
 * A facility offering that groups classes: "Preschool", "Rec Gym", "Team".
 * Its default times are the clock its classes run on unless a class says
 * otherwise, so a whole program can be staggered against another.
 */
export interface Program {
  id: number
  name: string
  /** "HH:MM" 24h, or null to fall back to the session's window. */
  defaultStartTime: string | null
  defaultEndTime: string | null
  isSample: boolean
}

export interface GymClass {
  id: number
  name: string
  /** The program it belongs to. */
  programId: number | null
  /** Higher priority wins when conflicts arise. */
  priority: number
  /** The class's structure, and the main input to generation. */
  requiredEvents: RequiredEvent[]
  /**
   * The class's own clock, overriding its program's. A window in a session
   * resolves to: the class's times, else its program's, else the session's.
   */
  defaultStartTime: string | null
  defaultEndTime: string | null
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
  /** Master window start, "HH:MM" 24h — the top of the time axis. */
  startTime: string
  /** Master window end, "HH:MM" 24h. */
  endTime: string
  /** How many columns (lanes) the grid has. */
  columnCount: number
  /** Read-only: how many distinct classes are placed in this session. */
  classCount: number
  /** Coaches marked absent for this session only (day-of change). */
  absentCoaches: number[]
  /** Events marked out for this session only (day-of change). */
  unavailableEvents: number[]
  isSample: boolean
}

/**
 * One event a class is doing for a span, inside its placement's window.
 * Blocks are explicit, never inferred by merging equal adjacent slots, so
 * two consecutive blocks on the same event keep a visible boundary.
 */
export interface EventBlock {
  /** Stable only within a loaded schedule; the grid saves in full. */
  id: number
  eventId: number
  coachId: number | null
  /** Minutes since midnight, snapped to SLOT_MINUTES. */
  startMin: number
  endMin: number
  /** Locked blocks survive regeneration; the solver plans around them. */
  locked: boolean
}

/**
 * A class sitting in one column for its own window. Placements in the same
 * column must not overlap in time; a column is a lane, not a class.
 */
export interface Placement {
  id: number
  classId: number
  columnIndex: number
  /** The class's own window, minutes since midnight, SLOT_MINUTES-snapped. */
  startMin: number
  endMin: number
  blocks: EventBlock[]
}

/** Everything the grid needs to render and save a session's schedule. */
export interface Schedule {
  placements: Placement[]
}

/** Where a class is placed, for showing whether its events fit. */
export interface ClassWindow {
  sessionId: number
  sessionName: string
  date: string
  startMin: number
  endMin: number
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
