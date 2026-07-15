// Solver input/output types. The solver is pure: plain data in, a schedule
// or failure explanation out. No UI, DOM, or database imports anywhere in
// src/solver/.
//
// The solver fills events inside each *placement* — a class in a column for
// its own window — not across the whole session. Generation is secondary to
// hand-painting, so it only ever deals in whole blocks the same shape the
// grid stores.
import type { AdjacencyPenalty, CoachMode } from '../../shared/types.ts'

export type { AdjacencyPenalty }

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
  /** Optional: a class with none is simply left alone. */
  requiredEvents: { eventId: number; duration: number }[]
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
