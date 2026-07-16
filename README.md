# Salto

Rotation scheduling for gymnastics gyms — auto-generate conflict-free practice schedules across events, classes, and coaches.

## Why

Gyms typically build practice rotation schedules by hand. Each session, multiple training classes rotate through a set of events (vault, bars, beam, floor, …). Doing this manually is slow and error-prone: two classes collide on the same equipment, a coach gets double-booked, or a class misses an event it needed.

Salto automates rotation schedule generation and gives coaches a clear, printable view of each session.

Salto is a general-purpose product: every gym defines its own events/stations, equipment, classes, coaches, and constraints. Nothing is hardcoded.

## Features

All three phases below are implemented — **v1 is feature-complete**.

**Phase 1 — Setup & manual grid**
- CRUD for **programs**, events, coaches, and classes — you enter your gym's structure once, in build order (Events → Programs → Classes → Sessions), with a first-run helper that guides the steps while leaving every page freely navigable
- A one-click (and one-click-removable) fictional example gym to explore before entering your own
- Every **event** carries its own duration and a shared/exclusive tag; a **class owns its schedule** — its program, the day(s) it meets, its start time and period length, the events it's *eligible* for, and its warm-up/cool-down — all entered in one place, grouped by program, with a "copy setup from another class" shortcut
- **Sessions are auto-derived, never created by hand:** classes are grouped by day + start time into weekly slots ("Monday 5:00 PM"), and the Sessions page is a read-only view of those slots
- The schedule grid: classes as columns, time as 5-minute rows, one per week with a Week 1–4 switcher, plus a coverage panel showing which events each class still needs
- Hand-editing for cleanup: drag a block's body to move it, its edge to resize, paint into empty rows, erase. A live tooltip says what the drag will do; a move that would collide is refused rather than eating your work
- Conflict highlighting: overlapping classes in a lane, a double-booked coach, an over-capacity event
- Data persistence
- Dockerfile + docker-compose.yml working end to end
- First-run admin account creation + login

**Phase 2 — Auto-generation** (the primary path)
- Open an auto-grouped slot (its classes are already there) and hit **Generate** for its **repeating four-week rotation plan**: each week draws a different mix of each class's eligible events, every eligible event is hit at least twice across the four weeks, warm-ups lead and cool-downs close, and no two classes are ever on the same exclusive apparatus at once. Lock a week and re-randomize the rest; gaps that can't be filled are flagged in plain language. Each slot's plan is independent and repeats every week — there's no per-week copying
- Clear reporting of unmet constraints when generation fails
- "Shuffle" — regenerate with a different seed for alternative layouts
- Lock cells and regenerate around them

**Phase 3 — Day-of changes & output**
- Mark a coach absent or an event out for a single session; affected cells are flagged, and "Repair schedule" fixes only what the outage touches — with a plain-language summary of what changed
- Print view: black-and-white-friendly block layout in the event colors, plus per-class "where do I go next" strips for handing to coaches
- Colored Excel export (a sheet per week) matching gyms' hand-made sheets
- A slot's four-week plan repeats every week automatically — the cycle *is* the recurring schedule, so there's no per-week copy step
- Light and dark mode, toggled from the header (sun = light, half moon = dark) and remembered per browser; defaults to your OS setting. The print view stays black-on-white whatever the screen is doing.

## How scheduling works

Scheduling is treated as a constraint-satisfaction problem over time slots of the session's rotation length.

Hard constraints (never violated): event capacity is respected — events are shared facility-wide, so two classes are never on the same apparatus at once — each class and each coach is in exactly one place at a time, every class completes all required events with their full durations inside **that class's own window**, position anchors hold (warm-ups first, cool-downs last), and inactive events are never used.

Soft constraints (optimized in priority order): higher-priority classes get their layout first, idle time is minimized, configurable adjacency penalties avoid back-to-back high-intensity events, and coaches stay with their class (or event, depending on gym mode).

The solver is a pure TypeScript module with no UI dependencies, deterministic given a seed, and reports *why* when no valid schedule exists.

## Tech stack

- React + TypeScript + Vite, Tailwind CSS
- Express backend serving the API and the built frontend from one process
- SQLite on a mounted volume for persistence
- Vitest for testing (property-based tests for the solver)

## Quick install

On a machine with Docker installed:

```bash
mkdir salto && cd salto
curl -fsSL https://raw.githubusercontent.com/Stevy2191/salto/main/install.sh | bash
```

The installer checks for Docker and Docker Compose, asks which port to use (default 3000), generates a `SESSION_SECRET` into `.env`, pulls the prebuilt image from GitHub Container Registry (`ghcr.io/stevy2191/salto`), and starts Salto. When it finishes, open the printed URL to create your admin account.

After installation the directory is **self-sufficient** — it contains `install.sh`, `uninstall.sh`, `docker-compose.yml`, `.env`, and a short `MANAGE.md` documenting the lifecycle commands, so you never need to come back to this repo to manage the app:

- **Update**: `docker compose pull && docker compose up -d`
- **Stop / start / logs**: `docker compose stop` / `docker compose up -d` / `docker compose logs -f`
- **Repair or update the install itself**: `./install.sh` — safe to re-run; it never touches your `.env` or data, just refreshes the scripts/compose file and pulls the latest image
- **Uninstall**: `./uninstall.sh` — stops and removes the containers, then asks separately (type `yes`) before deleting the `salto-data` volume, which permanently erases all schedules and settings

Your data lives on the `salto-data` Docker volume, not in the install directory — `MANAGE.md` includes a one-line backup/restore command for it.

## Deployment details

Salto is a single container: an Express server serving both the API and the built frontend, with SQLite on the mounted `salto-data` volume. Every push to `main` that passes the test suite is published to `ghcr.io/stevy2191/salto:latest` by a GitHub Actions workflow; `v*` tags additionally publish a version tag.

The committed `docker-compose.yml` references that public image, so a plain `docker compose up -d` deploys without cloning or building. For local development builds use the override: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build`.

The app listens on the host port set by `SALTO_PORT` (default `3000`). Environment variables are documented in [`.env.example`](.env.example). Never commit your real `.env`.

**Behind a reverse proxy (e.g. Nginx Proxy Manager):** point the proxy at the published port and serve the app at the root of its own subdomain (e.g. `salto.example.com`). The server binds `0.0.0.0` and trusts `X-Forwarded-*` headers from one proxy hop, so secure cookies and logging work behind the proxy. No base-path support in v1.

## Authentication

Instances are publicly reachable, so v1 requires login — kept deliberately simple:

- A single admin account, created on first run via a setup screen
- Session-based login with secure, httpOnly cookies
- Everything is behind login: hashed passwords, rate-limited login attempts, CSRF protection on mutations
- No OAuth, no user management UI, no roles (read-only coach share links are planned for Phase 3+)

## Development

```bash
npm install
npm start       # terminal 1: the Express API (and dist/, if built)
npm run dev     # terminal 2: Vite dev server, proxies /api to :3000
npm test        # run the test suite
npm run build   # typecheck and build for production
```

## Non-goals for v1

Billing, class registration, parent communication, multi-gym hosting, and long-term season planning are out of scope. See `SPEC.md` for the full specification.
