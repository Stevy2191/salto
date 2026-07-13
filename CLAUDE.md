# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Salto — rotation scheduling for gymnastics gyms. Auto-generates conflict-free practice schedules across events, groups, and coaches. Read `SPEC.md` for the full spec: data model, scheduling constraints, and phased feature plan.

## Commands

- `npm run dev` — start the Vite dev server
- `npm run build` — typecheck (`tsc -b`) and build for production
- `npm test` — run all tests once (Vitest)
- `npm run test:watch` — run tests in watch mode
- `npx vitest run path/to/file.test.ts` — run a single test file
- `npx vitest run -t "test name"` — run tests matching a name

## Conventions

- **The solver stays a pure TypeScript module** (`src/solver/`) with **no UI imports** — no React, no DOM, no component code. It must be swappable and testable in isolation. Test it exhaustively (property-based tests with fast-check per the spec).
- **Run tests before every commit.**
- **Build in the phase order from SPEC.md**: Phase 1 (CRUD + manual grid + persistence) → Phase 2 (auto-generation) → Phase 3 (day-of changes + print view). Don't start a later phase's features before the earlier phase works.
- Nothing gym-specific is hardcoded: events, groups, coaches, and constraints are all user-defined data. Never bake in a fixed list of events or assumptions about session structure.
- Use gym vocabulary in code and UI: "rotation," "event," "station," "session" — never "resource allocation" or "task."

## Architecture

- **Frontend:** React + TypeScript + Vite, Tailwind CSS for styling.
- **Solver:** `src/solver/` — pure TS constraint solver, zero UI dependencies. Treats scheduling as a CSP: hard constraints (capacity, no double-booking of groups/coaches, required events fit the session, inactive events unused) are never violated; soft constraints (priority ordering, minimal idle time, adjacency penalties, coach continuity) are optimized. Deterministic given a seed. When no schedule exists, it reports *why*, not just failure.
- **Testing:** Vitest. Solver tests live alongside the solver and must not depend on the UI.
