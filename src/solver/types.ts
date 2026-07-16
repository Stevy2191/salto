// Solver input/output types. The solver is pure: plain data in, a schedule
// or failure explanation out. No UI, DOM, or database imports anywhere in
// src/solver/.
//
// The solver fills events inside each *placement* — a class in a column for
// its own window — not across the whole session. Generation is the primary
// way a schedule is created, from the structure the gym entered: programs,
// their classes, and each class's events with per-class durations and
// position anchors. It deals only in whole blocks, the same shape the grid
// stores, so generated and hand-edited work are the same thing.
import type { AdjacencyPenalty, CoachMode, EventPosition } from '../../shared/types.ts'

export type { AdjacencyPenalty, EventPosition }

export interface SolverEvent {
  id: number
  name: string
  /** null = unlimited simultaneous classes. */
  capacity: number | null
  active: boolean
}

export interface SolverClass {
  id: number
  name: string
  priority: number
  /** The class's structure. A class with none is simply left alone. */
  requiredEvents: { eventId: number; duration: number; position: EventPosition }[]
  assignedCoaches: number[]
}

export interface SolverCoach {
  id: number
  name: string
  specialties: number[]
}

/** An event block, in minutes since midnight, snapped to SLOT_MINUTES. */
export interface SolverBlock {
  eventId: number
  coachId: number | null
  startMin: number
  endMin: number
}

/** A class sitting in a column for its own window. */
export interface SolverPlacement {
  id: number
  classId: number
  startMin: number
  endMin: number
  /** Blocks to preserve exactly; generation plans around them. */
  locked: SolverBlock[]
}

export interface SolverInput {
  events: SolverEvent[]
  classes: SolverClass[]
  coaches: SolverCoach[]
  placements: SolverPlacement[]
  coachMode: CoachMode
  adjacencyPenalties: AdjacencyPenalty[]
  seed: number
}

export interface SolverPlacementResult {
  placementId: number
  /** Locked blocks plus generated ones, ordered by start. */
  blocks: SolverBlock[]
}

export interface SolverSuccess {
  ok: true
  placements: SolverPlacementResult[]
  seed: number
}

export interface SolverFailure {
  ok: false
  /** Human-readable explanations — never empty. */
  reasons: string[]
}

export type SolverResult = SolverSuccess | SolverFailure
