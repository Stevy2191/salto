# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Salto — rotation scheduling for gymnastics gyms. Auto-generates conflict-free practice schedules across events, groups, and coaches. Read `SPEC.md` for the full spec: data model, scheduling constraints, and phased feature plan.

## Commands

- `npm run dev` — start the Vite dev server
- `npm run build` — typecheck (`tsc -b`) and build for production
- `npm start` — run the production Express server (serves `dist/`; build first)
- `npm test` — run all tests once (Vitest)
- `npm run test:watch` — run tests in watch mode
- `npx vitest run path/to/file.test.ts` — run a single test file
- `npx vitest run -t "test name"` — run tests matching a name
- `docker compose up -d --build` — build and run the production container

## Conventions

- **The solver stays a pure TypeScript module** (`src/solver/`) with **no UI imports** — no React, no DOM, no component code. It must be swappable and testable in isolation. Test it exhaustively (property-based tests with fast-check per the spec).
- **Run tests before every commit.**
- **Build in the phase order from SPEC.md**: Phase 1 (CRUD + manual grid + persistence) → Phase 2 (auto-generation) → Phase 3 (day-of changes + print view). Don't start a later phase's features before the earlier phase works.
- Nothing gym-specific is hardcoded: events, groups, coaches, and constraints are all user-defined data. Never bake in a fixed list of events or assumptions about session structure.
- Use gym vocabulary in code and UI: "rotation," "event," "station," "session" — never "resource allocation" or "task."

## Architecture

- **Frontend:** React + TypeScript + Vite, Tailwind CSS for styling.
- **Backend:** Express (`server/`), one process serving both the API (under `/api/`) and the built frontend from `dist/`, with an SPA fallback for client-side routes. SQLite will live in `DATA_DIR` (a mounted volume in Docker). Runtime dependencies (`dependencies` in package.json) are server-only — the frontend is bundled, so React and friends stay in `devDependencies` to keep the runtime image slim. The server runs TypeScript directly via Node's native type stripping (`node server/index.ts`, Node ≥ 22.18), so `tsconfig.server.json` enforces `erasableSyntaxOnly`.
- **Deployment:** self-hosted single container via the root `Dockerfile` (multi-stage: build frontend → slim runtime) and `docker-compose.yml`. Reverse-proxy friendly (Nginx Proxy Manager): binds `0.0.0.0`, port via `PORT` env var (default 3000), `trust proxy` enabled, no hardcoded hostnames or absolute URLs in the frontend; the app is served at the root of its own subdomain (no base-path support in v1). Config comes from environment variables documented in `.env.example` — keep that file current when adding config; never commit secrets.
- **Authentication (Phase 1):** single admin account created on first run via a setup screen; session-based login with secure httpOnly cookies. All routes behind login. Hash passwords (bcrypt/argon2), rate-limit login, CSRF-protect mutations. No OAuth, roles, or user management in v1.
- **Solver:** `src/solver/` — pure TS constraint solver, zero UI dependencies. Treats scheduling as a CSP: hard constraints (capacity, no double-booking of groups/coaches, required events fit the session, inactive events unused) are never violated; soft constraints (priority ordering, minimal idle time, adjacency penalties, coach continuity) are optimized. Deterministic given a seed. When no schedule exists, it reports *why*, not just failure.
- **Testing:** Vitest. Solver tests live alongside the solver and must not depend on the UI.
