// Solver input/output types. The solver is pure: plain data in, a schedule
// or failure explanation out. No UI, DOM, or database imports anywhere in
// src/solver/.
import type { AdjacencyPenalty, Assignment, CoachMode } from '../../shared/types.ts'

export type { AdjacencyPenalty }

export interface SolverEvent {
  id: number
  name: string
  capacity: number
  active: boolean
}

export interface SolverGroup {
  id: number
  name: string
  priority: number
  requiredEvents: { eventId: number; duration: number }[]
  assignedCoaches: number[]
}

export interface SolverCoach {
  id: number
  name: string
  specialties: number[]
}

export interface SolverInput {
  events: SolverEvent[]
  groups: SolverGroup[]
  coaches: SolverCoach[]
  /** Number of rotation slots in the session window. */
  slotCount: number
  /** Minutes per slot; required-event durations must be multiples of it. */
  rotationLength: number
  coachMode: CoachMode
  adjacencyPenalties: AdjacencyPenalty[]
  /** Pre-placed assignments that must be preserved exactly. */
  locked: Assignment[]
  seed: number
}

export interface SolverSuccess {
  ok: true
  assignments: Assignment[]
  seed: number
}

export interface SolverFailure {
  ok: false
  /** Human-readable explanations — never empty. */
  reasons: string[]
}

export type SolverResult = SolverSuccess | SolverFailure
