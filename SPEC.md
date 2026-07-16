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

Events are **facility-wide shared resources**, not owned by a program.
Classes from different programs routinely require the same one — Preschool's
Tiny Tot 1 and Rec Gym's Rec Gym 1 both want the Tumble Trak — and two
classes must never be on it at once. That contention is the core constraint
the generator exists to solve.
- `active` — can be marked unavailable (equipment down)
- `color` — hex color shown everywhere the event appears (grid, Excel
  export, print view). Users pick from a curated palette of distinct,
  print-friendly colors or choose a custom color; new events default to
  the next unused palette color.

### Coach
- `name`
- `specialties` — which events they can coach
- `availability` — which sessions/days they work

### Program
A facility offering that groups classes: "Preschool", "Rec Gym", "Team".
- `name`
- `defaultStartTime` / `defaultEndTime` — optional. The clock its classes
  run on by default, so a whole program can be staggered against another
  (Preschool 16:00–17:00 while Rec Gym runs 17:00–19:00).

A program is how a gym's structure is entered in bulk: classes hang off it,
and a session can take on a whole program's worth of classes at once.

### Class (training group)
Called "group" in early versions — the UI and API now say "class"; SQLite
storage keeps the original `groups` table name behind the server's mappers.
- `name` (e.g., "Tiny Tot 1", "Rec Gym 1", "Level 3 Girls")
- `programId` — the program it belongs to
- `level` / priority — higher-priority classes get first pick when conflicts
  arise (e.g., optionals over recreational)
- `requiredEvents` — **the class's structure, and the main input to
  generation.** A list of (event, **duration**, **position**):
  - `duration` is per class per event, never global: Tiny Tot 1 might do
    15 min at each event while Rec Gym 1 does 10.
  - `position` anchors the event in the class's order:
    - `FIRST` — the class starts with it (a warm-up)
    - `LAST` — the class ends with it (a cool-down)
    - `ANY` — free to fall anywhere in between
    Several `FIRST` events simply all come before everything else, in
    whatever order fits; likewise several `LAST` all come after. **A
    position anchors the order, not the clock**: a warm-up is the first
    thing the class does, not something pinned to the minute its window
    opens. Pinning would make perfectly good schedules impossible the
    moment two classes wanted the same warm-up apparatus — which is exactly
    what a shared Tumble Trak causes.
  While editing, the form shows the running total required time against the
  class's window, so a class that cannot fit is visible before generating.
- `defaultStartTime` / `defaultEndTime` — optional, overriding the
  program's. A class's window in a session defaults to its own times, else
  its program's, else the session's — so classes can run on different clocks
  and be staggered.
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

**Generate first; edit by hand only as cleanup.** A gym enters its
*structure* once — programs, their classes, each class's events with
durations and position anchors — and Salto turns that into a conflict-free
rotation on demand. Building a whole session by hand is not the intended
path; it is the touch-up afterwards.

This is a reversal of an earlier version, which made drag-to-paint primary
and generation optional. Gyms told us the manual work was the problem: the
structure is stable week to week, so it should be entered once and reused,
not re-drawn every session. Manual editing is still fully supported (see
"Editing") — it just is not where a schedule comes from.

### The grid
Classes across the top, time down the left — the same orientation as the
Excel export and the gyms' own hand-made sheets. Rows are 5 minutes and are
drawn at a **real, tappable height**: a single 5-minute slot is a normal
thing to paint, so it has to be a target you can hit. A 4-hour session is
~48 rows and scrolls vertically; rows are never compressed to fit a screen.
A light gridline marks every row, a stronger one every half hour and the
strongest on the hour, and the sticky time column labels every row.

Each column is a lane holding one or more class placements stacked in time;
the class header (name + its time range) sits at the top of its block within
the column. Outside a class's window the column is blank.

### Editing (cleanup)
Once a schedule is generated, the grid is where it gets tweaked: nudge a
block, stretch one, drop one that isn't happening today. Three gestures,
kept apart by **where the press lands**, so they never fight:

- **Empty rows inside a class → paint.** Pick an event from the palette and
  drag down the rows; the drag defines the length, the release commits.
  Painting *across* an existing block overwrites the span it crosses,
  trimming or splitting it.
- **A block's body → move it**, whole and at its original duration, to a new
  time and/or another class where that is valid.
- **A block's top/bottom edge → resize** that edge, with a resize cursor and
  a grip that appears on hover.

Everything snaps to 5 minutes. A live tooltip follows the pointer saying what
the drag will do ("Beam 16:05–16:20") and the target span is highlighted;
when a move would collide the tooltip and the target go red and the drop is
refused. Blocks stay inside the class's window and never overlap a sibling:
a resize clamps at its neighbour and a colliding move is refused, rather than
quietly eating work the user never pointed at.

Erasing is a palette tool (drag to clear a span) and each block also carries
a delete affordance, so removing something never needs a mode change.

Because a press on a block moves it, painting over a *fully* painted class is
done by dragging in from open time, erasing first, or deleting a block. That
is the cost of making move a first-class gesture, and it is the right trade:
moving and resizing are what a generated schedule needs most.

It must be fluid: minimal clicks, no keyboard needed, mouse or touch.

### Generation — the primary path
A session **gathers the classes attending** (pick a whole program, or pick
classes individually). Each lands on its own window — its own default times,
else its program's, else the session's — packed into columns so classes that
never overlap share a lane.

"Generate" then produces a **complete rotation in one shot**: every class
visits all of its required events for their full per-class durations, inside
its own window, honouring FIRST/LAST anchors, and **no two classes are ever
on the same event at once** (capacity permitting). "Shuffle" re-rolls the
seed for a different valid layout. Manual and generated blocks coexist, and
locked blocks are planned around.

**Hard constraints (never violated):**
1. An event's simultaneous classes never exceed its capacity (events
   without a limit are unconstrained). **This is the core one** — events are
   shared across programs and contended.
2. A class is in exactly one place at a time. (Structural: blocks live
   inside a placement and never overlap within it.)
3. A coach is in exactly one place at a time.
4. Each class completes its required events with their full durations
   **inside that class's own window** — not the session window.
5. Inactive events are never scheduled.
6. Blocks never fall outside their class's window.
7. Position anchors hold: every `FIRST` event comes before every `ANY` and
   `LAST` one, and every `LAST` after every `FIRST` and `ANY`.

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
- If no valid schedule exists, report *why*, specifically and per class —
  "Rec Gym 1 needs 40 min of events but its window is only 30 min", or
  "Tumble Trak is over-subscribed: 5 classes need 200 min on it between
  16:00–18:00, which only fits 120 min" — rather than failing silently.
  These messages are the user's only feedback when their structure doesn't
  work, so they have to name the class or the event at fault.
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
- CRUD for programs, events, coaches, classes, sessions — this structure is
  the main input, so entering it has to be fast
- **First-run experience:** a new gym sees an empty database and goes
  straight to the app — the Events / Classes / Coaches / Sessions pages are
  the setup. The home page points at them and offers **"load example gym"**,
  which seeds realistic sample data (clearly fictional names) so users can
  explore before entering their own. Sample data must be one-click
  removable. There is deliberately **no guided wizard**: it was tried and
  removed — it added a parallel way to do everything the normal pages
  already do, and a step order that real gyms don't follow.
- The schedule grid: **classes as columns, time as rows** (5-minute rows).
  It **displays** what generation decided and is where the schedule gets
  hand-tweaked; the generator, not the grid, is what puts a class on an
  event at a time (see "Building a schedule")
- Conflict highlighting in the manual editor (overlapping placements in a
  column; a coach or over-capacity event double-booked across columns)
- Data persistence
- Dockerfile + docker-compose.yml working end to end (see Deployment)
- First-run admin account creation + login (see Authentication)

This phase alone already beats the whiteboard, and it validates the data
model before the solver is built.

### Phase 2 — Auto-generation *(the primary path — see "Building a schedule")*
- Gather a session's classes by program or individually, then "Generate" a
  complete conflict-free rotation from the entered structure
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

- **Entering the structure is now the main input**, so the Programs /
  Classes / Events pages carry as much weight as the grid: grouped, quick to
  fill in, and honest about whether a class's events fit its window before
  the user hits Generate.
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
