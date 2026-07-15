# Salto — Project Spec

Rotation scheduling for gymnastics gyms — auto-generate conflict-free
practice schedules across events, classes, and coaches.

## Problem

Gymnastics gyms typically build their practice rotation schedules by hand.
Each practice session, multiple training classes must rotate through a set of
events (vault, bars, beam, floor, tumble track, conditioning, etc.). Building
the schedule manually is slow and error-prone: two classes end up on the same
equipment, a coach gets double-booked, or a class misses an event it needed.

Salto automates rotation schedule generation and gives coaches a clear,
printable view of each session.

**Salto is a general-purpose product, not a tool for one specific gym.**
Nothing is hardcoded: every gym defines its own events/stations, equipment,
classes, coaches, and constraints. Avoid baking in assumptions about which
events exist, how many classes there are, or how sessions are structured —
everything flows from user configuration.

## Users

- **Head coach / program director** (at any gym) — sets up their gym's
  events, classes, coaches, and constraints; generates and adjusts schedules.
- **Coaches** — view the schedule for their session; see where their class
  goes next.

Each installation serves one gym. Multi-gym hosting is out of scope for v1.

No parent/athlete-facing features in v1. Single admin login per instance
(see Authentication section).

## Core Entities (data model)

### Event (station)
Fully user-defined — the examples below are illustrative, never a fixed list.
- `name` (e.g., Vault, Uneven Bars, Beam, Floor, Tumble Track, Pit, Conditioning)
- `capacity` — optional limit on how many classes can use it simultaneously
  (apparatus usually 1; floor might fit 2). Unset means no limit — think
  open stretching areas or conditioning.
- `active` — can be marked unavailable (equipment down)
- `color` — hex color shown everywhere the event appears (grid, Excel
  export, print view). Users pick from a curated palette of distinct,
  print-friendly colors or choose a custom color; new events default to
  the next unused palette color.

### Coach
- `name`
- `specialties` — which events they can coach
- `availability` — which sessions/days they work

### Class (training group)
Called "group" in early versions — the UI and API now say "class"; SQLite
storage keeps the original `groups` table name behind the server's mappers.
- `name` (e.g., "Level 3 Girls", "Boys Team", "Xcel Silver")
- `level` / priority — higher-priority classes get first pick when conflicts
  arise (e.g., optionals over recreational)
- `requiredEvents` — the events this class must hit in a session, each with a
  **duration** (durations vary: e.g., 30 min beam, 20 min vault, 15 min
  conditioning)
- `assignedCoaches` — coaches who travel with this class (some gyms rotate
  coaches by event instead; support both via a setting)

### Session (practice block)
- `dayOfWeek`, `startTime`, `endTime`
- `classes` — which classes attend
- `rotationLength` — base time slot granularity (e.g., 15 min increments);
  event durations are multiples of this

### Schedule (generated output)
- For each time slot × event: which class is there, which coach is there
- Persisted so it can be reloaded, tweaked, and printed

## Scheduling Algorithm

This is the heart of the app. Treat it as a constraint-satisfaction problem:

**Hard constraints (never violated):**
1. An event's simultaneous classes never exceed its capacity (events
   without a limit are unconstrained).
2. A class is in exactly one place at a time.
3. A coach is in exactly one place at a time.
4. Each class completes all of its required events with their full durations
   within the session window.
5. Inactive events are never scheduled.

**Soft constraints (optimize, in priority order):**
1. Higher-priority classes get their preferred/required layout first.
2. Minimize idle slots ("dead time") for every class.
3. Avoid back-to-back high-intensity events for the same class (e.g., don't
   put conditioning immediately before beam) — make this a configurable
   adjacency-penalty list.
4. Coaches stay with their assigned class (or event, depending on gym mode).

**Suggested approach:**
- Discretize the session into slots of `rotationLength` minutes.
- Start with a greedy assignment ordered by class priority, backtracking when
  a class can't be placed.
- If greedy + backtracking proves insufficient, upgrade to a proper CSP
  solver. Keep the solver a pure, well-tested module with no UI dependencies
  so it can be swapped/upgraded independently.
- If no valid schedule exists, report *why* (e.g., "Level 3 needs 90 min of
  events but the session is 75 min") rather than failing silently.
- Generation should feel instant (<2s) for realistic sizes: ~10 classes, ~8
  events, ~12 slots.

**Test the solver hard.** Property-based tests: no double-bookings, all
required events fulfilled, output deterministic given a seed. Include fixture
scenarios: the impossible session, the exactly-tight session, the trivial
session.

## Features by Phase

> **Status:** Phases 1–3 below are implemented — v1 is feature-complete.
> Remaining ideas live under "Later / nice-to-have".

### Phase 1 — Setup & manual grid (walking skeleton)
- CRUD for events, coaches, classes, sessions
- **First-run experience:** a new gym sees an empty database. Provide a
  guided setup **wizard** that carries the user through the steps in order
  (add events → classes → coaches → first session) with Next/Back
  navigation and a visible progress indicator (step names + "Step N of 4").
  Steps aren't blocked on perfection — Next unlocks once the step has at
  least one item. Finishing lands on the newly created session's schedule
  grid with a brief pointer toward generation/manual assignment. The wizard
  is non-blocking: exit any time, resume from the home page (which shows
  setup progress), and completing setup another way — e.g. loading the
  example gym — dismisses the guide. Also provide a "load example gym"
  option that seeds realistic sample data (clearly fictional names) so
  users can explore before entering their own. Sample data must be
  one-click removable.
- A schedule grid (rows = events, columns = time slots; toggleable to
  rows = classes) where a schedule can be built/edited **manually** via
  drag-and-drop or click-to-assign
- Conflict highlighting in the manual editor (red cell when double-booked)
- Data persistence
- Dockerfile + docker-compose.yml working end to end (see Deployment)
- First-run admin account creation + login (see Authentication)

This phase alone already beats the whiteboard, and it validates the data
model before the solver is built.

### Phase 2 — Auto-generation
- "Generate schedule" for a session using the solver
- Show unmet constraints clearly when generation fails
- Regenerate with a different seed ("shuffle") to get alternative layouts
- Manual overrides on top of a generated schedule (lock a cell, regenerate
  around locks)

### Phase 3 — Day-of changes & output
- Mark a coach absent or an event down → regenerate around locked/kept
  assignments with minimal disruption (prefer schedules close to the original)
- Print view: clean, black-and-white-friendly, one page per session; big
  enough to read from across a gym. Also a per-class "where do I go next"
  strip. Uses the event colors, with a black-and-white-friendly fallback
  (color plus a pattern or the event name always present in text), since
  many gyms print in B&W.
- Excel export (shipped early, with the manual grid): download a session's
  schedule as .xlsx mirroring the on-screen layout — events as columns,
  time slots as rows, each occupied cell solid-filled with its event's
  color, class and coach names in the cell, and white/black text chosen
  automatically from the fill's brightness so it stays readable when
  printed from Excel.
- Copy a previous session's schedule as a starting point

### Later / nice-to-have (not v1)
- Coach login and read-only sharing links
- Recurring weekly templates
- Attendance-aware scheduling
- TV display mode that highlights the current rotation live

## Deployment

Salto is distributed as a self-hosted Docker application.

- **Single container:** Node backend serves both the API and the built React
  frontend. SQLite lives on a mounted volume so data survives container
  updates. No separate database service.
- **`docker-compose.yml` in the repo root** — a gym's entire deployment is
  `docker compose up -d`.
- **`Dockerfile` built and tested in Phase 1**, not bolted on later. Use a
  multi-stage build (build frontend → slim runtime image).
- **Reverse-proxy friendly (Nginx Proxy Manager):** bind to `0.0.0.0`,
  configurable port via env var (default e.g. `3000`), no hardcoded hostnames
  or absolute URLs in the frontend, trust `X-Forwarded-*` headers (Express
  `trust proxy`) so secure cookies and logging work behind NPM. Assume the
  app is served at the root of its own subdomain (e.g.,
  `salto.example.com`) — no base-path support needed in v1.
- **Configuration via environment variables** documented in the README and a
  committed `.env.example`. Secrets never committed.

## Distribution & Installation

Gyms should not need to clone the repo or build anything to run Salto.

- **Prebuilt images on GitHub Container Registry:** a GitHub Actions
  workflow builds the Docker image and pushes it to
  `ghcr.io/stevy2191/salto`. Every push to `main` publishes `:latest`
  (the image users pull); pushing a version tag (`v*`) additionally
  publishes that version tag (e.g. `1.2.0`). Publishing only happens if
  the test suite passes. The GHCR package is public so users can pull
  without authentication (one-time manual step in the package settings
  after the first push).
- **User-facing compose file:** the `docker-compose.yml` users deploy
  references the GHCR image — never a local build — so updating is just
  `docker compose pull && docker compose up -d`. Local development builds
  use a separate `docker-compose.dev.yml` build override.
- **`install.sh`** — interactive end-user setup script:
  checks Docker and Docker Compose are installed (friendly errors if not),
  asks which port to publish (default 3000), generates a random
  `SESSION_SECRET` into `.env`, downloads the compose file (or creates it
  if download fails), pulls the image, starts the stack, and finishes by
  printing the URL to visit to create the admin account plus the one-line
  update command.
- **`uninstall.sh`** — stops and removes the stack, then asks *separately*
  whether to delete the data volume, with a clear warning that doing so
  permanently deletes all schedules and settings.
- **README** documents a "Quick install" one-liner (curl the install
  script), the update command, and uninstall instructions.

## Authentication

Because instances are publicly accessible, v1 requires auth — but keep it
simple and single-gym:

- Single admin account created on first run (setup screen), session-based
  login (secure, httpOnly cookies).
- All routes behind login in v1; no anonymous access. (Read-only share links
  for coaches are a Phase 3+ feature.)
- Standard hygiene: hashed passwords (bcrypt/argon2), rate-limited login,
  CSRF protection on mutations.
- No OAuth, no user management UI, no roles in v1.

## Tech Stack (suggested)

- **Frontend:** React + TypeScript + Vite, Tailwind for styling
- **Backend:** Node (Express or Hono) + SQLite on a mounted volume. Serves
  API and static frontend from one process/container.
- **Solver:** Pure TypeScript module, `packages/solver` or `src/solver`,
  zero UI imports, exhaustive unit tests
- **Testing:** Vitest; property-based tests for the solver (fast-check)
- **Print view:** dedicated route with print CSS (`@media print`)

## UX Notes

- The schedule grid is the product. Invest there: readable at a glance,
  color-coded by event, dense but not cramped.
- Coaches use this poolside-style — chalky hands, phone or a printout.
  Big touch targets, works on a phone screen, prints cleanly.
- Terminology should match gym vocabulary: "rotation," "event," "station," "class,"
  "session" — never "resource allocation" or "task."

## Non-Goals for v1

- Billing, class registration, parent communication (other software does this)
- Multi-gym / multi-tenant support
- Long-term season planning — this is per-session scheduling
