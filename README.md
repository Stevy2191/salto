# Salto

Rotation scheduling for gymnastics gyms — auto-generate conflict-free practice schedules across events, groups, and coaches.

## Why

Gyms typically build practice rotation schedules by hand. Each session, multiple training groups rotate through a set of events (vault, bars, beam, floor, …). Doing this manually is slow and error-prone: two groups collide on the same equipment, a coach gets double-booked, or a group misses an event it needed.

Salto automates rotation schedule generation and gives coaches a clear, printable view of each session.

Salto is a general-purpose product: every gym defines its own events/stations, equipment, groups, coaches, and constraints. Nothing is hardcoded.

## Features

**Phase 1 — Setup & manual grid**
- CRUD for events, coaches, groups, and sessions
- Guided first-run setup, plus a one-click (and one-click-removable) example gym
- A schedule grid (events × time slots, toggleable to groups × time slots) with manual drag-and-drop / click-to-assign editing
- Conflict highlighting when a cell is double-booked
- Data persistence

**Phase 2 — Auto-generation**
- Generate a conflict-free schedule for a session with the constraint solver
- Clear reporting of unmet constraints when generation fails
- "Shuffle" — regenerate with a different seed for alternative layouts
- Lock cells and regenerate around them

**Phase 3 — Day-of changes & output**
- Mark a coach absent or an event down and regenerate with minimal disruption
- Print view: black-and-white-friendly, one page per session, readable from across a gym; per-group "where do I go next" strips
- Copy a previous session's schedule as a starting point

## How scheduling works

Scheduling is treated as a constraint-satisfaction problem over time slots of the session's rotation length.

Hard constraints (never violated): event capacity is respected, each group and each coach is in exactly one place at a time, every group completes all required events with their full durations inside the session window, and inactive events are never used.

Soft constraints (optimized in priority order): higher-priority groups get their layout first, idle time is minimized, configurable adjacency penalties avoid back-to-back high-intensity events, and coaches stay with their group (or event, depending on gym mode).

The solver is a pure TypeScript module with no UI dependencies, deterministic given a seed, and reports *why* when no valid schedule exists.

## Tech stack

- React + TypeScript + Vite, Tailwind CSS
- Vitest for testing (property-based tests for the solver)
- Local-first persistence

## Getting started

```bash
npm install
npm run dev     # start the dev server
npm test        # run the test suite
npm run build   # typecheck and build for production
```

## Non-goals for v1

Billing, class registration, parent communication, multi-gym hosting, and long-term season planning are out of scope. See `SPEC.md` for the full specification.
