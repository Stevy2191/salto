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
The facility enters **every** event used anywhere in the building, once.
Fully user-defined — the examples are illustrative, never a fixed list.
- `name` (e.g., PS Vault, Uneven Bars, Beam, Floor, Tumble Trak, Stretch)
- `duration` — **how long a class spends there per visit**, set when the
  event is created (PS Vault = 10 min). This is per event, facility-wide,
  not per class: the event's rotation length is a property of the station.
- `shared` — **the collision rule.** Events default to **exclusive**: only
  one class may be on an exclusive event at any given moment. A **shared**
  event (tag it) may hold any number of classes at once — for warm-up
  stretching, cool-down conditioning, open-floor work. Shared events are
  exempt from the no-collision rule; exclusive ones are not.
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
and the Classes and Sessions views group by program.

### Class (training group)
Called "group" in early versions — the UI and API now say "class"; SQLite
storage keeps the original `groups` table name behind the server's mappers.

**A class owns its own schedule.** The class — not a manually created session
— is the source of truth for *when* it meets. Everything about a practice
slot is derived from the classes that meet in it.
- `name` (e.g., "Tiny Tot 1", "Rec Gym 1", "Level 3 Girls")
- `programId` — the program it belongs to
- `daysOfWeek` — **which days it meets** (e.g. Mondays; or Mon + Wed), as a
  set of weekdays (0 = Sunday … 6 = Saturday).
- `startTime` — **the clock time it starts** on each of those days (e.g. 5:00
  PM). A class meets at the same time on every day it runs.
- `periodMinutes` — the class's total period length (e.g. 45 min); its window
  is `startTime … startTime + periodMinutes`.
- `level` / priority — higher-priority classes get first pick when conflicts
  arise (e.g., optionals over recreational)
- `eligibleEvents` — **the subset of facility events this class may use.**
  A class does *not* visit all of them in one period; it draws from this
  list. (LWM: PS Bars, PS Vault, Tumble Trak, PS Floor, Rec Beams.)
- `warmupEvent` / `warmupMinutes` — an optional fixed **opening** block: a
  stretch that leads every period, a length set per class. Usually a shared
  event.
- `cooldownEvent` / `cooldownMinutes` — an optional fixed **closing** block:
  conditioning/cool-down, a length set per class. Usually a shared event.

**The number of events per period is derived, not entered.** Period length
minus the warm-up and cool-down blocks leaves the *middle time*; how many
eligible events fit is that middle time divided by the events' own durations
(each event carries its duration). A 45-min period with a 5-min warm-up and
5-min cool-down leaves 35 min; four 10-min eligible events do not all fit, so
the class draws three of them that week. While editing, the form shows the
middle time and how many events it holds, so a class that cannot fit is
visible before generating.
- `programId` gives the class its program; `priority` breaks contention;
  `assignedCoaches` are coaches who travel with it (some gyms rotate coaches
  by event instead; support both via a setting).

**Within a week all classes run on the same clock** — they start and end
together at the session's times. That is *why* the no-collision rule bites:
at any moment two classes must not be on the same exclusive event.

### Session (practice slot) — **auto-derived, never manually created**
A session is a **weekly day + start-time slot** — "Monday 5:00 PM" — and it
is **derived automatically** from the classes that meet then. It is not a
dated event and it is not created by hand.

- `dayOfWeek` + `startTime` together **identify** the slot. Salto groups every
  class by `(day, startTime)`: all classes meeting Monday at 5:00 form the
  "Monday 5:00 PM" session. A class that meets Mon *and* Wed contributes to
  two slots.
- `endTime` — **derived**: the latest end among the slot's classes
  (`max(startTime + periodMinutes)`). This is the grid's time axis, drawn in
  fixed **5-minute rows**.
- Each slot carries its own **repeating 4-week plan** (locks, warnings, the
  generated blocks) — see Generation.

There is no manual "Add session" form and no session dates. The Sessions page
is a **read-only view** of the auto-grouped slots; the way to change what a
session contains is to change a class's schedule on the Classes page.
Reconciliation (create the slot when the first class adopts its day/time,
drop it when the last class leaves) is automatic.

There is no session-wide "rotation length": the axis is always 5 minutes and
every boundary snaps to it.

**One repeating 4-week plan per slot.** A slot's plan is the rotation it runs
*every* week of the month, cycling week 1 → 2 → 3 → 4 → 1. Repeating a
practice is not copying anything — the same slot simply recurs; regenerating
its plan re-rolls the four weeks. Each slot's plan is independent of every
other slot's.

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
one hard rule of the lane model, and it is rejected/flagged. Times a column
has no class present are simply **blank**; a class is never forced to fill
the timeline.

**Attendance is derived from each class's schedule, not gathered by hand.**
A class is in a slot because its `(day, startTime)` matches that slot; Salto
places it in its own column, in every week of the slot's plan, spanning its
own `startTime … startTime + periodMinutes` window. There is no manual
"add class to session" step and no attending list — editing a class's
schedule is what moves it between slots.

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

### Generation — a 4-week plan, the primary deliverable
Each **auto-derived slot** already holds its classes (everything meeting that
day and time, each on the shared clock). "Generate" produces that slot's
**four weeks of rotations at once** — same classes, same clock every week, a
*different* selection of events each week — and that four-week cycle is the
slot's **repeating monthly plan**. This, not a single day's schedule, is the
thing gyms actually want out of Salto. Every slot has its own plan; generating
one never touches another.

Each week, each class draws a subset of its eligible events that fills its
period (after the warm-up and cool-down), in a randomized order — varied
rotations are the whole point. Across the four weeks:

- **Coverage floor: every eligible event is attended at least 2 times**
  (target 2–3, spread as evenly as the math allows). Two is a hard floor;
  events left unused early are prioritized in later weeks to reach it.
- **Warm-up leads and cool-down closes** every class's period, where defined.
- **Exclusive events are never double-booked** within a week: at any moment,
  no two classes are on the same exclusive event. **Shared events may overlap
  freely** — that is what the shared tag buys.

**Best-effort, never silent.** If the constraints can't all be met — a
contested exclusive event simply can't give every class its two visits in the
time available — Salto still produces the best plan it can and **flags the
gaps in plain language**: *"Rec Beams: Rec Gym 1 only gets 1 of 2 required
visits — not enough non-conflicting slots across the 4 weeks."* It never
hands back an incomplete plan without saying so.

**Re-randomize with locks.** "Re-randomize" rolls a fresh 4-week plan. Any
week the user has **locked** stays exactly as it is; the other weeks reflow
around it. Deterministic given a seed, so the same seed and locks reproduce
the same plan.

**Hard constraints (never violated in a week):**
1. **No two classes on the same exclusive event at once.** This is the core
   constraint — events are shared facility-wide and contended. Shared-tagged
   events are exempt.
2. A class is in exactly one place at a time.
3. A coach is in exactly one place at a time.
4. Warm-up leads and cool-down closes the class's period.
5. Inactive events are never scheduled.
6. A locked week is returned byte-for-byte unchanged.

**Coverage constraint (best-effort, flagged when unmet):**
- Every eligible event of every class is attended ≥ 2 times across the four
  weeks, distributed 2–3 as evenly as possible.

**Suggested approach:**
- Reuse the single-week block solver per week: a class's events for a week
  become a warm-up (leads), the drawn middle events (any order), and a
  cool-down (closes), placed on the shared clock without exclusive
  collisions. A coverage layer decides *which* events each week, spreading
  under-covered events to later weeks.
- Keep the solver a pure, deterministic (by seed) module with no UI
  dependencies, so it can be swapped or upgraded independently.
- When a week can't place everything, drop the best-covered events and flag
  the shortfall, rather than failing the whole plan.
- Report *why* specifically, per class and per event — "Rec Beams: Rec Gym 1
  only gets 1 of 2 required visits" or "Tumble Trak is over-subscribed" —
  never a bare failure.
- A 4-week plan for ~16 classes should generate in a couple of seconds.

**Test the solver hard.** Property-based tests: no exclusive event
double-booked in any week; every class meets each eligible event's minimum
when feasible; a locked week is never altered on regenerate; shared events
are allowed to overlap; output deterministic given a seed. Fixture
scenarios: comfortably-solvable, tightly-contested (coverage impossible →
flags), single-class trivial.

## Features by Phase## Features by Phase

> **Status:** Phases 1–3 below are implemented — v1 is feature-complete.
> Remaining ideas live under "Later / nice-to-have".

### Phase 1 — Setup & manual grid (walking skeleton)
- CRUD for programs, events, coaches, classes, sessions — this structure is
  the main input, so entering it has to be fast
- **First-run experience — an ordered helper over the real pages, not a
  wizard.** A new gym is guided through the natural build order —
  **Step 1 Events → Step 2 Programs → Step 3 Classes → Step 4 Sessions** —
  with clear "Next" progression. Crucially this is *not* a locked overlay or a
  parallel set of throwaway screens (that earlier wizard was removed for
  exactly those reasons): every step is just the normal, independently-usable
  page, the full top nav stays visible the whole time, and the user can jump
  anywhere or leave the flow at any point. Once setup is done it stays out of
  the way — a dismissible progress hint on Home is enough; all pages remain
  freely navigable always. The home page also offers **"load example gym"**,
  which seeds realistic sample data (clearly fictional names, one-click
  removable) so users can explore before entering their own.
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
- Open an auto-derived slot (its classes are already in it) and "Generate" its
  repeating 4-week plan from the entered structure
- Show unmet constraints clearly when a slot's plan can't fully cover
- Regenerate with a different seed ("re-randomize") for alternative layouts,
  keeping any locked week
- Manual overrides on top of a generated week (lock a block, regenerate around
  locks)

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
  **four-week plan** as .xlsx (a sheet per week) mirroring the on-screen layout — **classes as columns,
  time as rows**, each occupied cell solid-filled with its event's color,
  event and coach names in the cell, and white/black text chosen
  automatically from the fill's brightness so it stays readable when
  printed from Excel. Set up to print landscape and tile across pages with
  the header row and time column repeating.
- A slot's plan repeats every week automatically — there is no per-week copy
  step; the four-week cycle *is* the recurring schedule.

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

- **Top-nav order follows the build order:** Home · Events · Programs ·
  Classes · Sessions · Coaches. Events → Programs → Classes are the setup
  steps left to right; Sessions is the payoff view (the auto-grouped slots you
  generate); Coaches is last (not yet part of generation).
- **The Classes page is the main input now** — a class is where day/time/
  length, program, eligible events, and warm-up/cool-down are all entered in
  one place, grouped by program, honest about whether the events fit the
  period before Generate, with a "copy setup from another class" shortcut so
  repeating the same eligible-event sets across many classes isn't tedious.
  The Events / Programs pages feed it.
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
