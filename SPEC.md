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
- `requiredEvents` — **optional**. The events this class must hit when the
  solver fills its window, each with a **duration** (a multiple of 5 min),
  freely editable per class (Silver does 20 min vault while Gold does 35).
  While editing, the form shows the total required time against the class's
  window in each session it is placed in, so a schedule that cannot fit is
  visible before generating. Required events are **only** an input to
  generation — painting a schedule by hand needs no setup at all.
- `assignedCoaches` — coaches who travel with this class (some gyms rotate
  coaches by event instead; support both via a setting)

### Session (practice block)
- `date` — the **specific calendar day** this practice happens (e.g.
  Monday, March 3), not a generic weekly slot: Monday week 1 differs from
  Monday week 2, and Monday differs from Tuesday. Session lists are sorted
  chronologically.
- `startTime`, `endTime` — the session's **master window** (e.g. 4:00–8:00).
  This is the time axis of the grid, drawn in fixed **5-minute rows**.
- `columnCount` — how many columns (lanes) the grid has.

There is no session-wide "rotation length": the axis is always 5 minutes and
every boundary snaps to it. Rotation lengths are a per-class, per-block
matter now — a class's blocks are whatever the user paints.

Repeating a practice week to week is **copying a session onto a new date**
(the copy prompts for it, defaulting a week out) — that is the primary
weekly workflow, not a recurrence rule. Recurring templates remain a
nice-to-have (see below).

### Column (lane)
A session's grid is a set of columns. **A column is not a class.** It is a
lane that holds a vertical sequence of one or more class placements stacked
in time. Columns can be added, removed, and reordered; a placement can be
moved to another column.

### Placement (a class in a column, for a window)
- `columnIndex` — which lane it sits in
- `classId` — which class
- `startMin`, `endMin` — the class's **own window** inside the session
  window (e.g. Silver 4:00–7:00), snapped to 5 minutes

Placements in the same column **must not overlap in time** — that is the
one hard rule of the lane model, and it is rejected/flagged. One column can
hold LV 1 (4:00–5:00), then LV 2 (5:00–6:00), then VYC 2 (6:00–8:00). Times
a column has no class present — before the first, between two, after the
last — are simply **blank**. A class is never forced to fill the timeline.

Attendance is expressed *entirely* by placements: a class is in a session
because it is placed somewhere in it. There is no separate attending list.

### Event block (what a class is doing, when)
- Belongs to a placement, so it always lives inside that class's window
- `eventId`, optional `coachId`, `startMin`/`endMin` (5-minute snapped)
- `locked` — survives regeneration; the solver plans around it

Blocks are stored **explicitly**, not inferred by merging equal adjacent
slots: two consecutive blocks on the same event are two blocks, and the
boundary between them stays visible. Blocks within a placement never
overlap; painting over an existing block overwrites the painted span.

## Building a schedule

**Drag-to-paint is the primary way a schedule gets built.** The solver is a
secondary convenience, not the main path. A head coach with a grid and a
mouse must be able to build a full session without configuring anything
first — no required events, no priorities, no setup.

### The grid
Classes across the top, time down the left — the same orientation as the
Excel export and the gyms' own hand-made sheets. Rows are 5 minutes. Each
column is a lane holding one or more class placements stacked in time; the
class header (name + its time range) sits at the top of its block within the
column. Outside a class's window the column is blank.

### Painting
- Pick an event from the palette, then click-drag down the 5-minute rows
  inside a class's window to paint that event across the span. The drag
  defines the length; releasing commits it. Everything snaps to 5 minutes.
- Painting over existing blocks overwrites the painted span.
- Drag the edge of a block to lengthen or shorten it.
- There is a fast way to erase a span.
- It must be fluid: minimal clicks, no keyboard needed, mouse or touch.

### Generation (optional)
"Generate" fills events **within each class's own window**, respecting that
class's required events and durations. Manual and generated blocks coexist,
and locked blocks are planned around.

**Hard constraints (never violated):**
1. An event's simultaneous classes never exceed its capacity (events
   without a limit are unconstrained).
2. A class is in exactly one place at a time. (Structural: blocks live
   inside a placement and never overlap within it.)
3. A coach is in exactly one place at a time.
4. Each class completes its required events with their full durations
   **inside that class's own window** — not the session window.
5. Inactive events are never scheduled.
6. Blocks never fall outside their class's window.

**Soft constraints (optimize, in priority order):**
1. Higher-priority classes get their preferred/required layout first.
2. Minimize idle time within each class's window.
3. Avoid back-to-back high-intensity events for the same class (e.g., don't
   put conditioning immediately before beam) — make this a configurable
   adjacency-penalty list.
4. Coaches stay with their assigned class (or event, depending on gym mode).

**Suggested approach:**
- Discretize each class's window into 5-minute slots.
- Start with a greedy assignment ordered by class priority, backtracking when
  a class can't be placed.
- If greedy + backtracking proves insufficient, upgrade to a proper CSP
  solver. Keep the solver a pure, well-tested module with no UI dependencies
  so it can be swapped/upgraded independently.
- If no valid schedule exists, report *why* against the class's own window
  ("Silver has 40 min of required events but only a 30-min window") rather
  than failing silently.
- Generation should feel instant (<2s) for realistic sizes: ~16 classes, ~8
  events, a 4-hour window at 5-minute rows.

**Test the solver hard.** Property-based tests: no double-bookings, all
required events fulfilled, nothing escapes its class window, output
deterministic given a seed. Include fixture scenarios: the impossible
window, the exactly-tight window, the trivial session.

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
- The schedule grid: **classes as columns, time as rows** (5-minute rows),
  built by placing classes into columns for their own windows and then
  **drag-painting** events down the rows (see "Building a schedule")
- Conflict highlighting in the manual editor (overlapping placements in a
  column; a coach or over-capacity event double-booked across columns)
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
- Print view: clean, black-and-white-friendly, big enough to read from
  across a gym. Also a per-class "where do I go next" strip. Uses the event
  colors, with a black-and-white-friendly fallback (the event name is always
  present in text), since many gyms print in B&W. **Landscape**, and it must
  handle real width: a session routinely has 16+ classes, so the sheet tiles
  across pages with the time column repeating on every page.
- Excel export (shipped early, with the manual grid): download a session's
  schedule as .xlsx mirroring the on-screen layout — **classes as columns,
  time as rows**, each occupied cell solid-filled with its event's color,
  event and coach names in the cell, and white/black text chosen
  automatically from the fill's brightness so it stays readable when
  printed from Excel. Set up to print landscape and tile across pages with
  the header row and time column repeating.
- Copy a session onto a new date — the weekly workflow: last Monday's
  practice becomes this Monday's, schedule and all

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
- **It has to hold up at real size.** A session routinely runs 16+ classes
  across a 3–4 hour window at 5-minute rows — 35–45+ rows by 16+ columns.
  The class headers and the time column stay stuck while scrolling both
  ways, event names stay legible without truncation, and dragging never
  lags.
- Coaches use this poolside-style — chalky hands, phone or a printout.
  Big touch targets, works on a phone screen, prints cleanly.
- **Light and dark mode**, switched from a button in the header (sun = light,
  half moon = dark) and remembered per browser; defaults to the OS setting.
  Gyms are lit anywhere from bright daylight to a dim evening office. The
  print view stays black-on-white whatever the screen is doing, and
  user-chosen event colors never change — they still encode the event.
- Terminology should match gym vocabulary: "rotation," "event," "station," "class,"
  "session" — never "resource allocation" or "task."

## Non-Goals for v1

- Billing, class registration, parent communication (other software does this)
- Multi-gym / multi-tenant support
- Long-term season planning — this is per-session scheduling
