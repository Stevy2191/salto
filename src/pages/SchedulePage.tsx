import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { Coach, GymClass, GymEvent, Schedule, Session, Settings } from '../../shared/types.ts'
import {
  SLOT_MINUTES,
  formatRange,
  rowCount,
  rowLabel,
  sessionWindow,
} from '../../shared/slots.ts'
import { formatDateLong } from '../../shared/dates.ts'
import { textColorFor } from '../../shared/colors.ts'
import { apiGet, apiPut } from '../lib/api.ts'
import { useLoad } from '../lib/useLoad.ts'
import {
  BLOCK_CONFLICT_LABELS,
  PLACEMENT_CONFLICT_LABELS,
  findConflicts,
} from '../lib/conflicts.ts'
import { sessionLabel } from '../lib/sessions.ts'
import {
  addPlacement,
  eraseSpan,
  movePlacement,
  paintSpan,
  removeColumn,
  removePlacement,
  resizeBlock,
  resizePlacement,
  swapColumns,
  toggleBlockLock,
} from '../lib/paint.ts'
import { generateSchedule } from '../solver/solver.ts'
import { describeRepairChanges, repairSchedule } from '../solver/repair.ts'
import { Button, Card, ChipPicker, ErrorNote, FieldGroup } from '../components/ui.tsx'
import { CopySessionDialog } from '../components/CopySessionDialog.tsx'
import { ROW_H, laneHeight, minToY, spanHeight, yToMin } from './schedule/grid.ts'
import { AddClassDialog, PlacementDialog } from './schedule/dialogs.tsx'

type SaveState = 'saved' | 'saving' | 'error'

/** What a drag on a lane does. Painting is the default, hence the primacy. */
type Tool = { kind: 'paint'; eventId: number } | { kind: 'erase' }

interface PaintDrag {
  kind: 'paint'
  placementId: number
  anchorMin: number
  toMin: number
}
interface ResizeDrag {
  kind: 'resize'
  placementId: number
  blockId: number
  edge: 'start' | 'end'
  toMin: number
}
type Drag = PaintDrag | ResizeDrag

export function SchedulePage() {
  const params = useParams()
  const sessionId = Number(params.id)
  const [searchParams, setSearchParams] = useSearchParams()
  const showWelcome = searchParams.get('welcome') === '1'
  const navigate = useNavigate()

  const sessionLoad = useLoad(() => apiGet<{ session: Session }>(`/api/sessions/${sessionId}`))
  const eventsLoad = useLoad(() => apiGet<{ events: GymEvent[] }>('/api/events'))
  const classesLoad = useLoad(() => apiGet<{ classes: GymClass[] }>('/api/classes'))
  const coachesLoad = useLoad(() => apiGet<{ coaches: Coach[] }>('/api/coaches'))
  const scheduleLoad = useLoad(() =>
    apiGet<{ schedule: Schedule }>(`/api/sessions/${sessionId}/schedule`),
  )
  const settingsLoad = useLoad(() => apiGet<{ settings: Settings }>('/api/settings'))

  const [schedule, setSchedule] = useState<Schedule | null>(null)
  const [columnCount, setColumnCount] = useState(0)
  const [tool, setTool] = useState<Tool | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [generationErrors, setGenerationErrors] = useState<string[] | null>(null)
  const [repairSummary, setRepairSummary] = useState<string[] | null>(null)
  const [copyOpen, setCopyOpen] = useState(false)
  const [addingTo, setAddingTo] = useState<number | null>(null)
  const [editingPlacement, setEditingPlacement] = useState<number | null>(null)

  useEffect(() => {
    if (scheduleLoad.data) setSchedule(scheduleLoad.data.schedule)
  }, [scheduleLoad.data])
  useEffect(() => {
    if (sessionLoad.data) setColumnCount(sessionLoad.data.session.columnCount)
  }, [sessionLoad.data])

  const session = sessionLoad.data?.session
  const events = eventsLoad.data?.events ?? []
  const classes = classesLoad.data?.classes ?? []
  const coaches = coachesLoad.data?.coaches ?? []
  const activeEvents = useMemo(() => events.filter((e) => e.active), [events])

  // Default the brush to the first event so painting is one click away.
  useEffect(() => {
    if (tool === null && activeEvents.length > 0) {
      setTool({ kind: 'paint', eventId: activeEvents[0]!.id })
    }
  }, [tool, activeEvents])

  const conflicts = useMemo(
    () => (schedule ? findConflicts(schedule, events) : null),
    [schedule, events],
  )

  const persist = useCallback(
    async (next: Schedule, previous: Schedule) => {
      setSchedule(next)
      setSaveState('saving')
      try {
        const res = await apiPut<{ schedule: Schedule }>(
          `/api/sessions/${sessionId}/schedule`,
          { placements: next.placements },
        )
        // Adopt the server's ids so later edits address real rows.
        setSchedule(res.schedule)
        setSaveState('saved')
        setSaveError(null)
      } catch (err) {
        setSchedule(previous)
        setSaveState('error')
        setSaveError(err instanceof Error ? err.message : 'could not save')
      }
    },
    [sessionId],
  )

  const setColumns = async (next: number) => {
    const previous = columnCount
    setColumnCount(next)
    try {
      await apiPut(`/api/sessions/${sessionId}/columns`, { columnCount: next })
      setSaveError(null)
    } catch (err) {
      setColumnCount(previous)
      setSaveError(err instanceof Error ? err.message : 'could not change columns')
    }
  }

  // --- Dragging. Pointer capture keeps the gesture alive outside the lane,
  // and the live drag stays in state so the grid can preview it without a
  // round trip. Only the release writes.
  const laneRefs = useRef(new Map<number, HTMLDivElement>())

  const minAtPointer = useCallback(
    (columnIndex: number, clientY: number, round = false) => {
      const lane = laneRefs.current.get(columnIndex)
      if (!lane || !session) return null
      const rect = lane.getBoundingClientRect()
      return yToMin(session, clientY - rect.top, { round })
    },
    [session],
  )

  useEffect(() => {
    if (!drag || !schedule || !session) return
    const move = (e: PointerEvent) => {
      const placement = schedule.placements.find((p) => p.id === drag.placementId)
      if (!placement) return
      const min = minAtPointer(placement.columnIndex, e.clientY, drag.kind === 'resize')
      if (min === null) return
      setDrag((d) => (d ? { ...d, toMin: min } : d))
    }
    const up = () => {
      const previous = schedule
      let next: Schedule | null = null
      if (drag.kind === 'paint') {
        // A click with no travel still paints one row.
        const to = drag.toMin === drag.anchorMin ? drag.anchorMin + SLOT_MINUTES : drag.toMin
        const from = drag.anchorMin
        const [lo, hi] = from < to ? [from, to] : [to, from + SLOT_MINUTES]
        next =
          tool?.kind === 'erase'
            ? eraseSpan(schedule, drag.placementId, lo, hi)
            : tool
              ? paintSpan(schedule, drag.placementId, tool.eventId, lo, hi)
              : null
      } else {
        next = resizeBlock(schedule, drag.placementId, drag.blockId, drag.edge, drag.toMin)
      }
      setDrag(null)
      if (next && next !== schedule) void persist(next, previous)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', () => setDrag(null))
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [drag, schedule, session, tool, persist, minAtPointer])

  const loadError =
    sessionLoad.error ??
    eventsLoad.error ??
    classesLoad.error ??
    coachesLoad.error ??
    scheduleLoad.error ??
    settingsLoad.error
  if (loadError) return <ErrorNote message={loadError} />
  if (!session || !schedule || !conflicts) return null

  const rows = rowCount(session)
  const { startMin, endMin } = sessionWindow(session)
  const classById = new Map(classes.map((c) => [c.id, c]))
  const eventById = new Map(events.map((e) => [e.id, e]))
  const coachById = new Map(coaches.map((c) => [c.id, c]))
  const columns = Array.from({ length: columnCount }, (_, i) => i)

  const apply = (next: Schedule | null) => {
    if (next) void persist(next, schedule)
  }

  /**
   * Remove a lane. Only an empty one — a column holding a class is a real
   * thing someone built, so say so rather than silently deleting the work.
   * The remaining lanes shift left before the count drops, so the save never
   * references a column that no longer exists.
   */
  const dropColumn = async (columnIndex: number) => {
    if (schedule.placements.some((p) => p.columnIndex === columnIndex)) {
      setSaveError('That column still holds a class — move or remove it first.')
      return
    }
    setSaveError(null)
    await persist(removeColumn(schedule, columnIndex), schedule)
    await setColumns(columnCount - 1)
  }

  // --- Day-of outages ---
  const absentSet = new Set(session.absentCoaches)
  const downSet = new Set(session.unavailableEvents)
  const outagesActive = absentSet.size > 0 || downSet.size > 0
  const outageFor = (eventId: number, coachId: number | null): string | undefined => {
    if (downSet.has(eventId)) return `${eventById.get(eventId)?.name ?? 'This event'} is out today`
    if (coachId !== null && absentSet.has(coachId))
      return `${coachById.get(coachId)?.name ?? 'The coach'} is out today`
    return undefined
  }
  const affected = schedule.placements
    .flatMap((p) => p.blocks)
    .filter((b) => outageFor(b.eventId, b.coachId) !== undefined).length

  const setOutages = async (absentCoaches: number[], unavailableEvents: number[]) => {
    try {
      await apiPut(`/api/sessions/${sessionId}/outages`, { absentCoaches, unavailableEvents })
      setSaveError(null)
      await sessionLoad.reload()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'could not save outages')
    }
  }

  const solverBits = () => ({
    events: events.map(({ id, name, capacity, active }) => ({ id, name, capacity, active })),
    classes: classes.map(({ id, name, priority, requiredEvents, assignedCoaches }) => ({
      id,
      name,
      priority,
      requiredEvents,
      assignedCoaches,
    })),
    coaches: coaches.map(({ id, name, specialties }) => ({ id, name, specialties })),
    coachMode: settingsLoad.data!.settings.coachMode,
    adjacencyPenalties: settingsLoad.data!.settings.adjacencyPenalties,
    seed: Math.floor(Math.random() * 2 ** 31),
  })

  const generate = () => {
    if (!settingsLoad.data) return
    const unlocked = schedule.placements.flatMap((p) => p.blocks.filter((b) => !b.locked)).length
    if (
      unlocked > 0 &&
      !confirm(
        `Replace ${unlocked} unlocked block${unlocked === 1 ? '' : 's'}? ` +
          `Locked blocks (🔒) are kept. Lock anything you painted by hand that you want to survive.`,
      )
    ) {
      return
    }
    const result = generateSchedule({
      ...solverBits(),
      placements: schedule.placements.map((p) => ({
        id: p.id,
        classId: p.classId,
        startMin: p.startMin,
        endMin: p.endMin,
        locked: p.blocks
          .filter((b) => b.locked)
          .map(({ eventId, coachId, startMin, endMin }) => ({ eventId, coachId, startMin, endMin })),
      })),
    })
    if (!result.ok) {
      setGenerationErrors(result.reasons)
      return
    }
    setGenerationErrors(null)
    apply(fromSolver(schedule, result.placements))
  }

  const repair = () => {
    if (!settingsLoad.data) return
    const result = repairSchedule({
      ...solverBits(),
      placements: schedule.placements.map((p) => ({
        id: p.id,
        classId: p.classId,
        startMin: p.startMin,
        endMin: p.endMin,
        blocks: p.blocks.map(({ eventId, coachId, startMin, endMin, locked }) => ({
          eventId,
          coachId,
          startMin,
          endMin,
          locked,
        })),
      })),
      absentCoachIds: session.absentCoaches,
      unavailableEventIds: session.unavailableEvents,
    })
    if (!result.ok) {
      setGenerationErrors(result.reasons)
      setRepairSummary(null)
      return
    }
    setRepairSummary(describeRepairChanges(result.changes, { events, classes, coaches }))
    setGenerationErrors(null)
    apply(fromSolver(schedule, result.placements))
  }

  const startPaint = (placementId: number, columnIndex: number, e: React.PointerEvent) => {
    if (!tool) return
    const min = minAtPointer(columnIndex, e.clientY)
    if (min === null) return
    e.preventDefault()
    setDrag({ kind: 'paint', placementId, anchorMin: min, toMin: min })
  }

  /** The span the current paint drag would write, for the live preview. */
  const previewSpan = (placementId: number): { from: number; to: number } | null => {
    if (!drag || drag.kind !== 'paint' || drag.placementId !== placementId) return null
    const to = drag.toMin === drag.anchorMin ? drag.anchorMin + SLOT_MINUTES : drag.toMin
    return drag.anchorMin < to
      ? { from: drag.anchorMin, to }
      : { from: to, to: drag.anchorMin + SLOT_MINUTES }
  }

  return (
    <div className="space-y-4">
      {showWelcome && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-indigo-50 p-4 ring-1 ring-indigo-200 dark:bg-indigo-950 dark:ring-indigo-800">
          <p className="flex-1 text-sm text-indigo-900 dark:text-indigo-100">
            🎉 <span className="font-semibold">Setup complete</span> — add your classes to columns,
            then pick an event and <span className="font-semibold">drag down the grid</span> to
            paint it. Everything snaps to 5 minutes.
          </p>
          <Button variant="secondary" onClick={() => setSearchParams({}, { replace: true })}>
            Got it
          </Button>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">
            {sessionLabel(session)}
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {formatDateLong(session.date)} · {formatRange(startMin, endMin)} · {rows} rows of{' '}
            {SLOT_MINUTES} min
            {conflicts.count > 0 && (
              <span className="ml-2 font-medium text-red-600 dark:text-red-400">
                ⚠ {conflicts.count} conflict{conflicts.count === 1 ? '' : 's'}
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`text-sm ${saveState === 'error' ? 'font-medium text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400'}`}
          >
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : 'Save failed'}
          </span>
          <Button variant="secondary" onClick={() => setCopyOpen(true)}>
            Copy session
          </Button>
          <Link
            to={`/sessions/${sessionId}/print`}
            className="min-h-11 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 dark:bg-slate-700 dark:text-slate-200 dark:ring-slate-600 dark:hover:bg-slate-600"
          >
            Print
          </Link>
          <a
            href={`/api/sessions/${sessionId}/export`}
            download
            className="min-h-11 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 dark:bg-slate-700 dark:text-slate-200 dark:ring-slate-600 dark:hover:bg-slate-600"
          >
            Export to Excel
          </a>
        </div>
      </div>

      <ErrorNote message={saveError} />

      {/* The brush. Painting is the primary way a schedule gets built, so
          the palette sits directly above the grid, always visible. */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-white p-3 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700">
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">Paint:</span>
        {activeEvents.map((event) => {
          const active = tool?.kind === 'paint' && tool.eventId === event.id
          return (
            <button
              key={event.id}
              onClick={() => setTool({ kind: 'paint', eventId: event.id })}
              aria-pressed={active}
              aria-label={`paint ${event.name}`}
              className={`min-h-10 rounded-lg px-3 py-1.5 text-sm font-semibold ring-1 ring-black/10 ${
                active ? 'outline-2 outline-offset-2 outline-slate-900 dark:outline-slate-100' : ''
              }`}
              style={{ backgroundColor: event.color, color: textColorFor(event.color) }}
            >
              {event.name}
            </button>
          )
        })}
        <button
          onClick={() => setTool({ kind: 'erase' })}
          aria-pressed={tool?.kind === 'erase'}
          aria-label="erase"
          className={`min-h-10 rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 dark:bg-slate-700 dark:text-slate-200 dark:ring-slate-600 ${
            tool?.kind === 'erase'
              ? 'outline-2 outline-offset-2 outline-slate-900 dark:outline-slate-100'
              : ''
          }`}
        >
          Erase
        </button>
        <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
          Drag down a class to paint · drag a block's edge to resize
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {schedule.placements.length > 0 && (
          <>
            <Button onClick={generate}>Generate</Button>
            <Button variant="secondary" onClick={generate} title="Regenerate with a new seed">
              Shuffle
            </Button>
          </>
        )}
        <Button variant="secondary" onClick={() => void setColumns(columnCount + 1)}>
          + Add column
        </Button>
      </div>

      {repairSummary && (
        <div
          role="status"
          className="rounded-xl bg-emerald-50 p-4 ring-1 ring-emerald-200 dark:bg-emerald-950 dark:ring-emerald-800"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="font-semibold text-emerald-900 dark:text-emerald-100">
              Schedule repaired
            </p>
            <button
              onClick={() => setRepairSummary(null)}
              aria-label="dismiss"
              className="rounded px-1 text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900"
            >
              ×
            </button>
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-emerald-900 dark:text-emerald-100">
            {repairSummary.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {generationErrors && (
        <div
          role="alert"
          className="rounded-xl bg-red-50 p-4 ring-1 ring-red-200 dark:bg-red-950 dark:ring-red-800"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="font-semibold text-red-800 dark:text-red-300">Couldn't generate</p>
            <button
              onClick={() => setGenerationErrors(null)}
              aria-label="dismiss"
              className="rounded px-1 text-red-400 hover:bg-red-100 dark:hover:bg-red-900"
            >
              ×
            </button>
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-red-700 dark:text-red-300">
            {generationErrors.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      <details
        open={outagesActive}
        className="rounded-xl bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700"
      >
        <summary className="cursor-pointer text-sm font-semibold text-slate-700 dark:text-slate-200">
          Day-of changes
          {affected > 0 && (
            <span className="ml-2 font-medium text-amber-600 dark:text-amber-400">
              ⚠ {affected} block{affected === 1 ? '' : 's'} affected
            </span>
          )}
        </summary>
        <div className="mt-3 space-y-3">
          <FieldGroup label="Coaches out for this session">
            <ChipPicker
              tone="amber"
              options={coaches.map((c) => ({ id: c.id, label: c.name }))}
              selected={session.absentCoaches}
              onChange={(ids) => void setOutages(ids, session.unavailableEvents)}
            />
          </FieldGroup>
          <FieldGroup label="Events out for this session">
            <ChipPicker
              tone="amber"
              options={activeEvents.map((e) => ({ id: e.id, label: e.name }))}
              selected={session.unavailableEvents}
              onChange={(ids) => void setOutages(session.absentCoaches, ids)}
            />
          </FieldGroup>
          {outagesActive && (
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={repair}>Repair schedule</Button>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Keeps everything unaffected in place; only fixes what the outage touches.
              </p>
            </div>
          )}
        </div>
      </details>

      {columnCount === 0 ? (
        <Card>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            This session has no columns yet. A column is a lane that can hold one class at a time —
            add one, then place a class into it for its own time window.
          </p>
          <div className="mt-3">
            <Button onClick={() => void setColumns(1)}>+ Add the first column</Button>
          </div>
        </Card>
      ) : (
        <div className="overflow-auto rounded-xl bg-white ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700">
          <div
            className="grid min-w-max"
            style={{ gridTemplateColumns: `4rem repeat(${columnCount}, 11rem)` }}
          >
            {/* Header row — sticky so 16 lanes stay identifiable while
                scrolling down 48 rows. */}
            <div className="sticky left-0 top-0 z-30 border-b border-r border-slate-200 bg-slate-100 p-2 text-xs font-semibold text-slate-500 dark:border-slate-700 dark:bg-slate-700 dark:text-slate-300">
              Time
            </div>
            {columns.map((c) => {
              const inLane = schedule.placements
                .filter((p) => p.columnIndex === c)
                .sort((a, b) => a.startMin - b.startMin)
              return (
                <div
                  key={c}
                  className="sticky top-0 z-20 border-b border-r border-slate-200 bg-slate-100 p-2 dark:border-slate-700 dark:bg-slate-700"
                >
                  <div className="flex items-center gap-1">
                    <span className="flex-1 truncate text-xs font-semibold text-slate-600 dark:text-slate-300">
                      {inLane.length > 0
                        ? inLane.map((p) => classById.get(p.classId)?.name ?? '?').join(' → ')
                        : `Column ${c + 1}`}
                    </span>
                    <button
                      onClick={() => apply(swapColumns(schedule, c, c - 1))}
                      disabled={c === 0}
                      aria-label={`move column ${c + 1} left`}
                      className="rounded px-1 text-slate-500 hover:bg-slate-200 disabled:opacity-30 dark:text-slate-400 dark:hover:bg-slate-600"
                    >
                      ‹
                    </button>
                    <button
                      onClick={() => apply(swapColumns(schedule, c, c + 1))}
                      disabled={c === columnCount - 1}
                      aria-label={`move column ${c + 1} right`}
                      className="rounded px-1 text-slate-500 hover:bg-slate-200 disabled:opacity-30 dark:text-slate-400 dark:hover:bg-slate-600"
                    >
                      ›
                    </button>
                    <button
                      onClick={() => void dropColumn(c)}
                      aria-label={`remove column ${c + 1}`}
                      className="rounded px-1 text-slate-400 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-950"
                    >
                      ×
                    </button>
                  </div>
                  <button
                    onClick={() => setAddingTo(c)}
                    className="mt-1 w-full rounded bg-white px-2 py-1 text-xs font-medium text-indigo-600 ring-1 ring-slate-300 hover:bg-indigo-50 dark:bg-slate-800 dark:text-indigo-400 dark:ring-slate-600 dark:hover:bg-slate-700"
                  >
                    + Add class
                  </button>
                </div>
              )
            })}

            {/* Time column — sticky left, so a wide grid keeps its clock. */}
            <div
              className="sticky left-0 z-10 border-r border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-700"
              style={{ height: laneHeight(session) }}
            >
              {Array.from({ length: rows }, (_, i) => (
                <div
                  key={i}
                  className={`px-2 text-right text-[10px] leading-none text-slate-500 dark:text-slate-400 ${
                    rowLabel(session, i).endsWith(':00')
                      ? 'font-bold text-slate-700 dark:text-slate-200'
                      : ''
                  }`}
                  style={{ height: ROW_H, paddingTop: 2 }}
                >
                  {rowLabel(session, i).endsWith(':00') || rowLabel(session, i).endsWith(':30')
                    ? rowLabel(session, i)
                    : ''}
                </div>
              ))}
            </div>

            {/* Lanes. Rows are drawn as a background gradient rather than 48
                divs per column, and blocks are absolutely positioned — at 16
                lanes that is a few hundred nodes instead of many thousand. */}
            {columns.map((c) => (
              <div
                key={c}
                ref={(el) => {
                  if (el) laneRefs.current.set(c, el)
                  else laneRefs.current.delete(c)
                }}
                className="relative border-r border-slate-200 dark:border-slate-700"
                style={{
                  height: laneHeight(session),
                  backgroundImage: `repeating-linear-gradient(to bottom, transparent, transparent ${ROW_H - 1}px, var(--row-line) ${ROW_H - 1}px, var(--row-line) ${ROW_H}px)`,
                }}
              >
                {schedule.placements
                  .filter((p) => p.columnIndex === c)
                  .map((p) => {
                    const cls = classById.get(p.classId)
                    const placementConflicts = conflicts.placements.get(p.id)
                    const preview = previewSpan(p.id)
                    return (
                      <div
                        key={p.id}
                        data-testid={`placement-${p.id}`}
                        className={`absolute inset-x-0 touch-none ${
                          placementConflicts
                            ? 'ring-2 ring-red-500'
                            : 'ring-1 ring-slate-300 dark:ring-slate-600'
                        }`}
                        title={placementConflicts
                          ?.map((r) => PLACEMENT_CONFLICT_LABELS[r])
                          .join('; ')}
                        style={{
                          top: minToY(session, p.startMin),
                          height: spanHeight(p.startMin, p.endMin),
                        }}
                        onPointerDown={(e) => {
                          // Only a bare lane press paints; the header and the
                          // resize handles have their own gestures.
                          if ((e.target as HTMLElement).closest('[data-no-paint]')) return
                          startPaint(p.id, c, e)
                        }}
                      >

                        {p.blocks.map((b) => {
                          const event = eventById.get(b.eventId)
                          const color = event?.color ?? '#BAB0AC'
                          const reasons = conflicts.blocks.get(b.id)
                          const outage = outageFor(b.eventId, b.coachId)
                          const coach = b.coachId === null ? undefined : coachById.get(b.coachId)
                          return (
                            <div
                              key={b.id}
                              data-testid={`block-${b.eventId}-${b.startMin}`}
                              // Thick top/bottom edges keep the boundary
                              // visible even between two same-colored blocks.
                              className={`absolute inset-x-0 overflow-hidden border-y-2 border-black/40 px-1 ${
                                reasons ? 'ring-2 ring-inset ring-red-500' : ''
                              } ${!reasons && outage ? 'ring-2 ring-inset ring-amber-500' : ''} ${
                                b.locked ? 'outline-2 -outline-offset-2 outline-slate-900' : ''
                              }`}
                              // Colour always encodes the event, conflict or
                              // not; the warning is the ring and the marker.
                              style={{
                                top: minToY(session, b.startMin) - minToY(session, p.startMin),
                                height: spanHeight(b.startMin, b.endMin),
                                backgroundColor: color,
                                color: textColorFor(color),
                              }}
                              title={
                                reasons?.map((r) => BLOCK_CONFLICT_LABELS[r]).join('; ') ??
                                outage ??
                                `${event?.name ?? 'Event'} ${formatRange(b.startMin, b.endMin)}`
                              }
                            >
                              {/* Name once at the top of the block; the color
                                  carries through the rest of the span. A block
                                  starting exactly at its class's start drops
                                  its label below the floating class header so
                                  the event name is never hidden by it. */}
                              <div
                                className="flex items-start gap-0.5"
                                style={{ paddingTop: b.startMin === p.startMin ? 14 : 0 }}
                              >
                                <button
                                  data-no-paint
                                  onClick={() => apply(toggleBlockLock(schedule, p.id, b.id))}
                                  aria-label={b.locked ? `unlock ${event?.name}` : `lock ${event?.name}`}
                                  aria-pressed={b.locked}
                                  className={`shrink-0 text-[9px] leading-none ${b.locked ? '' : 'opacity-40'}`}
                                >
                                  {b.locked ? '🔒' : '🔓'}
                                </button>
                                <span className="min-w-0 flex-1 text-[10px] font-semibold leading-tight">
                                  {reasons || outage ? '⚠ ' : ''}
                                  {event?.name ?? 'Unknown'}
                                  {coach && (
                                    <span className="block truncate font-normal opacity-80">
                                      {coach.name}
                                    </span>
                                  )}
                                </span>
                              </div>
                              {/* Edge handles: drag to lengthen or shorten. */}
                              <div
                                data-no-paint
                                role="slider"
                                aria-label={`resize ${event?.name ?? 'block'} start`}
                                aria-valuenow={b.startMin}
                                tabIndex={-1}
                                onPointerDown={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  setDrag({
                                    kind: 'resize',
                                    placementId: p.id,
                                    blockId: b.id,
                                    edge: 'start',
                                    toMin: b.startMin,
                                  })
                                }}
                                className="absolute inset-x-0 top-0 h-1.5 cursor-ns-resize touch-none bg-black/10 hover:bg-black/40"
                              />
                              <div
                                data-no-paint
                                role="slider"
                                aria-label={`resize ${event?.name ?? 'block'} end`}
                                aria-valuenow={b.endMin}
                                tabIndex={-1}
                                onPointerDown={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  setDrag({
                                    kind: 'resize',
                                    placementId: p.id,
                                    blockId: b.id,
                                    edge: 'end',
                                    toMin: b.endMin,
                                  })
                                }}
                                className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize touch-none bg-black/10 hover:bg-black/40"
                              />
                            </div>
                          )
                        })}

                        {/* Class header: name + its own window, floated over
                            the top of the class's block. It deliberately does
                            not occupy a row: a 5-minute row spent on a label
                            would push the first event block down and misreport
                            its time, and the axis has to stay honest. */}
                        <button
                          data-no-paint
                          onClick={() => setEditingPlacement(p.id)}
                          title={`${cls?.name ?? 'Unknown class'} ${formatRange(p.startMin, p.endMin)} — click to edit`}
                          className={`absolute left-0 right-0 top-0 z-[5] truncate px-1 text-left text-[10px] font-bold leading-tight ring-1 ring-black/20 ${
                            placementConflicts
                              ? 'bg-red-200 text-red-900'
                              : 'bg-amber-100/95 text-amber-950'
                          }`}
                        >
                          {placementConflicts ? '⚠ ' : ''}
                          {cls?.name ?? 'Unknown class'}{' '}
                          <span className="font-normal opacity-80">
                            {formatRange(p.startMin, p.endMin)}
                          </span>
                        </button>

                        {/* Live preview of the drag in progress. */}
                        {preview && tool && (
                          <div
                            className="pointer-events-none absolute inset-x-0 opacity-70 ring-2 ring-slate-900 dark:ring-slate-100"
                            style={{
                              top: minToY(session, preview.from) - minToY(session, p.startMin),
                              height: spanHeight(preview.from, preview.to),
                              backgroundColor:
                                tool.kind === 'paint'
                                  ? (eventById.get(tool.eventId)?.color ?? '#888')
                                  : 'transparent',
                            }}
                          />
                        )}
                      </div>
                    )
                  })}
              </div>
            ))}
          </div>
        </div>
      )}

      {columnCount > 0 && schedule.placements.length === 0 && (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No classes placed yet — use <span className="font-semibold">+ Add class</span> on a column
          to give a class its own time window, then paint events down its rows.
        </p>
      )}

      {copyOpen && (
        <CopySessionDialog
          session={session}
          onClose={() => setCopyOpen(false)}
          onCopied={(newId) => navigate(`/sessions/${newId}/schedule`)}
        />
      )}
      {addingTo !== null && (
        <AddClassDialog
          session={session}
          classes={classes}
          columnIndex={addingTo}
          onClose={() => setAddingTo(null)}
          onAdd={(classId, from, to) => {
            const next = addPlacement(schedule, classId, addingTo, from, to)
            // The dialog says why; it has the user's attention and the
            // fields they'd need to change. Repeating it on the page behind
            // would just be the same sentence twice.
            if (!next) return false
            apply(next)
            setAddingTo(null)
            return true
          }}
        />
      )}
      {editingPlacement !== null &&
        (() => {
          const p = schedule.placements.find((x) => x.id === editingPlacement)
          if (!p) return null
          return (
            <PlacementDialog
              session={session}
              placement={p}
              className={classById.get(p.classId)?.name ?? 'Unknown class'}
              columnCount={columnCount}
              onClose={() => setEditingPlacement(null)}
              onRemove={() => {
                apply(removePlacement(schedule, p.id))
                setEditingPlacement(null)
              }}
              onSave={(from, to, columnIndex) => {
                let next: Schedule | null = schedule
                if (columnIndex !== p.columnIndex) {
                  next = movePlacement(next, p.id, columnIndex)
                  if (!next) return 'That column is already busy at those times.'
                }
                next = resizePlacement(next, p.id, from, to)
                if (!next) return 'That window collides with another class in the column.'
                apply(next)
                setEditingPlacement(null)
                return null
              }}
            />
          )
        })()}
    </div>
  )
}

/** Fold solver output back into the grid, keeping placements and locks. */
function fromSolver(
  schedule: Schedule,
  results: { placementId: number; blocks: { eventId: number; coachId: number | null; startMin: number; endMin: number }[] }[],
): Schedule {
  let localId = -1
  return {
    placements: schedule.placements.map((p) => {
      const result = results.find((r) => r.placementId === p.id)
      if (!result) return p
      const wasLocked = new Set(
        p.blocks.filter((b) => b.locked).map((b) => `${b.eventId}:${b.startMin}:${b.endMin}`),
      )
      return {
        ...p,
        blocks: result.blocks.map((b) => ({
          id: localId--,
          eventId: b.eventId,
          coachId: b.coachId,
          startMin: b.startMin,
          endMin: b.endMin,
          locked: wasLocked.has(`${b.eventId}:${b.startMin}:${b.endMin}`),
        })),
      }
    }),
  }
}
