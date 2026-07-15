# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Salto — rotation scheduling for gymnastics gyms. Auto-generates conflict-free practice schedules across events, classes, and coaches. Read `SPEC.md` for the full spec: data model, scheduling constraints, and phased feature plan.

## Commands

- `npm run dev` — start the Vite dev server (proxies `/api` to `localhost:3000`, so also run `npm start` in another terminal for a working API)
- `npm run build` — typecheck (`tsc -b`) and build for production
- `npm start` — run the Express server (serves the API, plus `dist/` if built)
- `npm test` — run all tests once (Vitest)
- `npm run test:watch` — run tests in watch mode
- `npx vitest run path/to/file.test.ts` — run a single test file
- `npx vitest run -t "test name"` — run tests matching a name
- `npm run test:e2e` — Playwright smoke tests (`e2e/`); boots its own production build on port 3456 with a throwaway DB (`.e2e-data/`). One-time setup: `npx playwright install chromium`, plus `sudo npx playwright install-deps chromium` on bare hosts. Not part of `npm test`.
- `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build` — build and run the container from local sources (plain `docker compose up -d` pulls the published GHCR image instead)

## Conventions

- **The solver stays a pure TypeScript module** (`src/solver/`) with **no UI imports and no database imports** — plain data in (`SolverInput`), a schedule or human-readable failure reasons out (`SolverResult`). It runs client-side in the browser (bundled), and results persist through the normal assignments API. It must be swappable and testable in isolation.
- **Solver testing:** `src/solver/validate.ts` is an independent hard-constraint checker, deliberately not sharing solver internals, so tests cross-check two implementations. Property-based tests (fast-check) assert no ok result ever violates a hard constraint, failures always explain themselves, and same seed ⇒ same schedule. Keep the perf test (<2s for ~10 classes / 8 events / 12 slots) passing. Any new solver behavior needs fixture + property coverage.
- **Run tests before every commit.**
- **Build in the phase order from SPEC.md**: Phase 1 (CRUD + manual grid + persistence) → Phase 2 (auto-generation) → Phase 3 (day-of changes + print view). Don't start a later phase's features before the earlier phase works.
- Nothing gym-specific is hardcoded: events, classes, coaches, and constraints are all user-defined data. Never bake in a fixed list of events or assumptions about session structure.
- Use gym vocabulary in code and UI: "rotation," "event," "station," "class," "session" — never "resource allocation" or "task." A training group is a **class** (renamed from "group" after user testing); only SQLite storage still uses the legacy `groups`/`group_id` names, translated in the server's row mappers.
- Events carry a `color` (curated palette + custom, palette and contrast helpers in `shared/colors.ts`). Color always encodes the *event* wherever schedules are rendered — grid, Excel export (`GET /api/sessions/:id/export`, generated server-side with exceljs), and the future print view.

## Architecture

- **Frontend:** React + TypeScript + Vite, Tailwind CSS for styling.
- **Backend:** Express (`server/`), one process serving both the API (under `/api/`) and the built frontend from `dist/`, with an SPA fallback for client-side routes. SQLite via built-in `node:sqlite` (no native modules), stored in `DATA_DIR` (a mounted volume in Docker). Schema changes are **append-only migrations** in `server/migrations.ts`, tracked via `PRAGMA user_version` — never edit an existing migration; add a new one to the end. Runtime dependencies (`dependencies` in package.json) are server-only — the frontend is bundled, so React and friends stay in `devDependencies` to keep the runtime image slim. The server runs TypeScript directly via Node's native type stripping (`node server/index.ts`, Node ≥ 22.18), so `tsconfig.server.json` enforces `erasableSyntaxOnly`.
- **Shared code:** `shared/` holds types and pure helpers (slot math) imported by both server and frontend; it is copied into the Docker image, so runtime code is allowed there. `src/lib/conflicts.ts` is the pure conflict-detection module (no UI imports) whose rules become the solver's hard constraints in Phase 2.
- **Distribution:** releases are Docker images on `ghcr.io/stevy2191/salto`, published by `.github/workflows/release.yml`: every push to `main` publishes `:latest` after the test suite passes; `v*` tags additionally publish `<version>`. A push to `main` therefore ships to users — keep `main` releasable. The committed `docker-compose.yml` is what end users deploy — it must reference the GHCR image, never `build:`; local builds go through `docker-compose.dev.yml`. `install.sh`/`uninstall.sh` are the end-user setup scripts; keep them in sync with the compose file (the installer embeds a fallback copy of it).
- **Deployment:** self-hosted single container via the root `Dockerfile` (multi-stage: build frontend → slim runtime) and `docker-compose.yml`. Reverse-proxy friendly (Nginx Proxy Manager): binds `0.0.0.0`, port via `PORT` env var (default 3000), `trust proxy` enabled, no hardcoded hostnames or absolute URLs in the frontend; the app is served at the root of its own subdomain (no base-path support in v1). Config comes from environment variables documented in `.env.example` — keep that file current when adding config; never commit secrets.
- **Authentication:** single admin account created on first run via the setup screen; session-based login with httpOnly SameSite=Lax cookies. Sessions are opaque random tokens stored SHA-256-hashed in SQLite (no signing secret needed). Passwords are hashed with Node's built-in scrypt (chosen over bcrypt/argon2 to avoid native builds in Alpine). Login is rate-limited in memory; mutations are CSRF-checked against the Origin header. All `/api` routes except health/setup/login/me require the session. No OAuth, roles, or user management in v1.
- **Solver:** `src/solver/` — pure TS constraint solver, zero UI dependencies. Treats scheduling as a CSP: hard constraints (capacity, no double-booking of classes/coaches, required events fit the session, inactive events unused) are never violated; soft constraints (priority ordering, minimal idle time, adjacency penalties, coach continuity) are optimized. Deterministic given a seed. When no schedule exists, it reports *why*, not just failure.
- **Testing:** Vitest. Solver tests live alongside the solver and must not depend on the UI.
