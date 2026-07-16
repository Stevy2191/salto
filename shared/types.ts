// Entity types shared between the server and the frontend.
//
// Naming note: the product term for a training group is "class" (renamed
// from "group" after user testing). SQLite storage keeps the original
// `groups` table / `group_id` column names — the server's row mappers
// translate — so deployed databases never needed a rename migration.

export interface GymEvent {
  id: number
  name: string
  /**
   * How long a class spends here per visit, in minutes — a facility-wide
   * property of the station, not per class. A multiple of SLOT_MINUTES.
   */
  duration: number
  /**
   * The collision rule. Exclusive (false, the default) means only one class
   * may be on this event at a time — the constraint the planner solves.
   * Shared (true) events hold any number at once: stretch, conditioning,
   * open floor.
   */
  shared: boolean
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
  /**
   * The days this class meets (0 = Sunday … 6 = Saturday). A class meeting
   * Mon and Wed contributes to two derived session slots at the same time.
   */
  daysOfWeek: number[]
  /**
   * The clock time the class starts on each of its days, "HH:MM" 24h, or null
   * if not scheduled yet. With daysOfWeek it fixes which slot the class is in;
   * its window is startTime … startTime + periodMinutes.
   */
  startTime: string | null
  /**
   * The subset of facility events this class may use. Each week the planner
   * draws from this list — the class does not visit all of them per period.
   */
  eligibleEventIds: number[]
  /** Total period length in minutes, a multiple of SLOT_MINUTES. */
  periodMinutes: number
  /** Optional fixed opening block (a warm-up, usually a shared event). */
  warmupEventId: number | null
  warmupMinutes: number
  /** Optional fixed closing block (a cool-down, usually a shared event). */
  cooldownEventId: number | null
  cooldownMinutes: number
  /** Coach ids who travel with this class. */
  assignedCoaches: number[]
  isSample: boolean
}

/** A class's derived period budget: how much middle time and how it's spent. */
export interface PeriodFit {
  /** Minutes of period left for eligible events after warm-up and cool-down. */
  middleMinutes: number
  /** How many of the class's eligible events fit that middle time. */
  eventsThatFit: number
  /** True when even one eligible event doesn't fit the middle time. */
  overflows: boolean
}

export interface Session {
  id: number
  /** Derived display label, e.g. "Monday 5:00 PM". */
  name: string
  /**
   * The weekday this slot recurs on (0 = Sunday … 6 = Saturday). With
   * startTime it identifies the slot; sessions are auto-derived from the
   * classes meeting then, never created by hand or tied to a calendar date.
   */
  dayOfWeek: number
  /** Slot start, "HH:MM" 24h — the top of the time axis and the grouping key. */
  startTime: string
  /** Slot end, "HH:MM" 24h — derived from the latest-ending class. */
  endTime: string
  /** How many columns (lanes) the grid has — one per class in the slot. */
  columnCount: number
  /** Read-only: how many distinct classes meet in this slot. */
  classCount: number
  /** Which of the 4 weeks are locked (index 0 = week 1). */
  weekLocks: boolean[]
  /** Plain-language coverage/collision gaps from the last generation. */
  planWarnings: string[]
  /** Coaches marked absent for this session only (day-of change). */
  absentCoaches: number[]
  /** Events marked out for this session only (day-of change). */
  unavailableEvents: number[]
  isSample: boolean
}

/** How many weeks a rotation plan spans. */
export const PLAN_WEEKS = 4

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
  /** Which week (1..PLAN_WEEKS) of the plan this placement belongs to. */
  week: number
  /** The class's own window, minutes since midnight, SLOT_MINUTES-snapped. */
  startMin: number
  endMin: number
  blocks: EventBlock[]
}

/** One week of the grid: the placements the grid renders and saves. */
export interface Schedule {
  placements: Placement[]
}

/** How many times a class visits an eligible event across the whole plan. */
export interface EventCoverage {
  eventId: number
  visits: number
  /** Below the floor of 2 the planner could not reach. */
  short: boolean
}

/** A class's coverage across the 4-week plan. */
export interface ClassCoverage {
  classId: number
  events: EventCoverage[]
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
