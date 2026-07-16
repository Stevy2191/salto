import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type {
  ClassCoverage,
  Coach,
  GymClass,
  GymEvent,
  Schedule,
  Session,
  Settings,
} from '../../shared/types.ts'
import { PLAN_WEEKS } from '../../shared/types.ts'
import {
  SLOT_MINUTES,
  formatRange,
  rowCount,
  rowLabel,
  sessionWindow,
} from '../../shared/slots.ts'
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
  blockBounds,
  eraseSpan,
  moveBlock,
  moveTarget,
  paintSpan,
  removeBlock,
  resizeBlock,
  toggleBlockLock,
} from '../lib/paint.ts'
import { generatePlan } from '../solver/plan.ts'
import type { PlanPlacement } from '../solver/plan.ts'
import { describeRepairChanges, repairSchedule } from '../solver/repair.ts'
import { Button, Card, ChipPicker, ErrorNote, FieldGroup } from '../components/ui.tsx'
import { ROW_H, laneBackground, laneHeight, minToY, spanHeight, yToMin } from './schedule/grid.ts'

type SaveState = 'saved' | 'saving' | 'error'

/** What a drag on empty grid does. Painting is the primary gesture. */
type Tool = { kind: 'paint'; eventId: number } | { kind: 'erase' }

/**
 * The three gestures are kept apart by *where* the press lands, so they can
 * never fight each other:
 *   empty grid inside a class  → paint (or erase, with that tool)
 *   the body of a block        → move it whole, duration intact
 *   the top/bottom edge        → resize that edge
 */
interface StrokeDrag {
  kind: 'paint' | 'erase'
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
interface MoveDrag {
  kind: 'move'
  placementId: number
  blockId: number
  /** How far into the block the user grabbed, so it doesn't jump. */
  grabOffsetMin: number
  /** Where the block would land: class, and its new start. */
  toPlacementId: number
  toStartMin: number
}
type Drag = StrokeDrag | ResizeDrag | MoveDrag

/** Where the pointer is, for the drag tooltip. */
interface Pointer {
  x: number
  y: number
}

export function SchedulePage() {
  const params = useParams()
  const sessionId = Number(params.id)

  const sessionLoad = useLoad(() => apiGet<{ session: Session }>(`/api/sessions/${sessionId}`))
  const eventsLoad = useLoad(() => apiGet<{ events: GymEvent[] }>('/api/events'))
  const classesLoad = useLoad(() => apiGet<{ classes: GymClass[] }>('/api/classes'))
  const coachesLoad = useLoad(() => apiGet<{ coaches: Coach[] }>('/api/coaches'))
  // Which week of the plan the grid is showing. The schedule loader reads it
  // from a ref so reload() always fetches the visible week.
  const [week, setWeek] = useState(1)
  const weekRef = useRef(1)
  const scheduleLoad = useLoad(() =>
    apiGet<{ schedule: Schedule }>(`/api/sessions/${sessionId}/schedule?week=${weekRef.current}`),
  )
  const settingsLoad = useLoad(() => apiGet<{ settings: Settings }>('/api/settings'))

  const [schedule, setSchedule] = useState<Schedule | null>(null)
  const [columnCount, setColumnCount] = useState(0)
  const [tool, setTool] = useState<Tool | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [pointer, setPointer] = useState<Pointer | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [generationErrors, setGenerationErrors] = useState<string[] | null>(null)
  const [repairSummary, setRepairSummary] = useState<string[] | null>(null)
  const [coverage, setCoverage] = useState<ClassCoverage[] | null>(null)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    if (scheduleLoad.data) setSchedule(scheduleLoad.data.schedule)
  }, [scheduleLoad.data])
  // Switching weeks refetches that week's grid.
  useEffect(() => {
    weekRef.current = week
    void scheduleLoad.reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [week])
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
          `/api/sessions/${sessionId}/schedule?week=${weekRef.current}`,
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

  // --- Dragging. The gesture lives on window so it survives leaving the
  // lane, and the live drag stays in state so the grid previews it without a
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

  /** Which lane the pointer is over, so a move can cross columns. */
  const columnAtPointer = useCallback((clientX: number) => {
    for (const [columnIndex, lane] of laneRefs.current) {
      const rect = lane.getBoundingClientRect()
      if (clientX >= rect.left && clientX <= rect.right) return columnIndex
    }
    return null
  }, [])

  useEffect(() => {
    if (!drag || !schedule || !session) return

    const onMove = (e: PointerEvent) => {
      setPointer({ x: e.clientX, y: e.clientY })
      if (drag.kind === 'move') {
        // Follow the pointer across lanes: land in whichever class sits under
        // it at that moment, if any; otherwise stay put.
        const column = columnAtPointer(e.clientX)
        const min = column === null ? null : minAtPointer(column, e.clientY, true)
        if (min === null || column === null) return
        const start = min - drag.grabOffsetMin
        const target =
          schedule.placements.find(
            (p) => p.columnIndex === column && min >= p.startMin && min < p.endMin,
          ) ?? schedule.placements.find((p) => p.id === drag.toPlacementId)
        if (!target) return
        setDrag((d) =>
          d && d.kind === 'move' ? { ...d, toPlacementId: target.id, toStartMin: start } : d,
        )
        return
      }
      const placement = schedule.placements.find((p) => p.id === drag.placementId)
      if (!placement) return
      const min = minAtPointer(placement.columnIndex, e.clientY, drag.kind === 'resize')
      if (min === null) return
      setDrag((d) => (d ? { ...d, toMin: min } : d))
    }

    const finish = () => {
      const previous = schedule
      let next: Schedule | null = null
      if (drag.kind === 'paint' || drag.kind === 'erase') {
        // A click with no travel still covers the one row pressed.
        const to = drag.toMin === drag.anchorMin ? drag.anchorMin + SLOT_MINUTES : drag.toMin
        const from = drag.anchorMin
        const [lo, hi] = from < to ? [from, to] : [to, from + SLOT_MINUTES]
        next =
          drag.kind === 'erase'
            ? eraseSpan(schedule, drag.placementId, lo, hi)
            : tool?.kind === 'paint'
              ? paintSpan(schedule, drag.placementId, tool.eventId, lo, hi)
              : null
      } else if (drag.kind === 'resize') {
        next = resizeBlock(schedule, drag.placementId, drag.blockId, drag.edge, drag.toMin)
      } else if (drag.kind === 'move') {
        // A colliding move is simply refused — landing on a block and eating
        // it would destroy work the user never pointed at.
        next = moveBlock(
          schedule,
          drag.placementId,
          drag.blockId,
          drag.toPlacementId,
          drag.toStartMin,
        )
      }
      setDrag(null)
      setPointer(null)
      if (next && next !== schedule) void persist(next, previous)
    }

    const cancel = () => {
      setDrag(null)
      setPointer(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
    }
  }, [drag, schedule, session, tool, persist, minAtPointer, columnAtPointer])

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

  // Provisional bridge to the single-week solver: capacity mirrors the
  // shared flag, and a class's structure is warm-up → eligible events →
  // cool-down, each at its facility duration. The 4-week plan generator
  // (which picks a per-week subset for coverage) supersedes this.
  const requiredEventsOf = (cls: (typeof classes)[number]) => {
    const list: { eventId: number; duration: number; position: 'FIRST' | 'ANY' | 'LAST' }[] = []
    if (cls.warmupEventId !== null) {
      list.push({ eventId: cls.warmupEventId, duration: cls.warmupMinutes, position: 'FIRST' })
    }
    for (const id of cls.eligibleEventIds) {
      list.push({ eventId: id, duration: eventById.get(id)?.duration ?? SLOT_MINUTES, position: 'ANY' })
    }
    if (cls.cooldownEventId !== null) {
      list.push({ eventId: cls.cooldownEventId, duration: cls.cooldownMinutes, position: 'LAST' })
    }
    return list
  }

  const solverBits = () => ({
    events: events.map(({ id, name, shared, active }) => ({
      id,
      name,
      capacity: shared ? null : 1,
      active,
    })),
    classes: classes.map((cls) => ({
      id: cls.id,
      name: cls.name,
      priority: cls.priority,
      requiredEvents: requiredEventsOf(cls),
      assignedCoaches: cls.assignedCoaches,
    })),
    coaches: coaches.map(({ id, name, specialties }) => ({ id, name, specialties })),
    coachMode: settingsLoad.data!.settings.coachMode,
    adjacencyPenalties: settingsLoad.data!.settings.adjacencyPenalties,
    seed: Math.floor(Math.random() * 2 ** 31),
  })

  // Generate the whole four-week plan. Fetches every week (for the locked
  // blocks it must plan around), runs the pure plan solver, then writes back
  // each unlocked week plus the plan's locks and warnings. Locked weeks are
  // left alone.
  const generatePlanNow = async () => {
    if (!settingsLoad.data || !session) return
    const locks = session.weekLocks
    if (
      !confirm(
        'Generate the four-week plan? Unlocked weeks are rebuilt; locked weeks (and locked blocks) are kept.',
      )
    ) {
      return
    }
    setGenerating(true)
    setGenerationErrors(null)
    try {
      // Every week's current grid, so the plan can preserve locked work.
      const weekSchedules = await Promise.all(
        Array.from({ length: PLAN_WEEKS }, (_, i) =>
          apiGet<{ schedule: Schedule }>(`/api/sessions/${sessionId}/schedule?week=${i + 1}`).then(
            (r) => r.schedule,
          ),
        ),
      )
      const planPlacements: PlanPlacement[] = weekSchedules.flatMap((sched, i) =>
        sched.placements.map((p) => ({
          id: p.id,
          classId: p.classId,
          week: i + 1,
          startMin: p.startMin,
          endMin: p.endMin,
          blocks: p.blocks.map((b) => ({
            eventId: b.eventId,
            coachId: b.coachId,
            startMin: b.startMin,
            endMin: b.endMin,
            locked: b.locked,
          })),
        })),
      )

      const result = generatePlan({
        events: events.map(({ id, name, duration, shared, active }) => ({
          id,
          name,
          duration,
          shared,
          active,
        })),
        classes: classes.map((cls) => ({
          id: cls.id,
          name: cls.name,
          priority: cls.priority,
          eligibleEventIds: cls.eligibleEventIds,
          periodMinutes: cls.periodMinutes,
          warmupEventId: cls.warmupEventId,
          warmupMinutes: cls.warmupMinutes,
          cooldownEventId: cls.cooldownEventId,
          cooldownMinutes: cls.cooldownMinutes,
          assignedCoaches: cls.assignedCoaches,
        })),
        coaches: coaches.map(({ id, name, specialties }) => ({ id, name, specialties })),
        placements: planPlacements,
        weekLocks: locks,
        coachMode: settingsLoad.data.settings.coachMode,
        adjacencyPenalties: settingsLoad.data.settings.adjacencyPenalties,
        seed: Math.floor(Math.random() * 2 ** 31),
      })
      if (!result.ok) {
        setGenerationErrors(result.reasons)
        return
      }

      // Write each unlocked week back, preserving which blocks were locked.
      for (let w = 1; w <= PLAN_WEEKS; w++) {
        if (locks[w - 1]) continue
        const sched = weekSchedules[w - 1]!
        const planWeek = result.weeks.find((x) => x.week === w)
        const placements = sched.placements.map((p) => {
          const pr = planWeek?.placements.find((r) => r.placementId === p.id)
          const wasLocked = new Set(
            p.blocks.filter((b) => b.locked).map((b) => `${b.eventId}:${b.startMin}:${b.endMin}`),
          )
          return {
            classId: p.classId,
            columnIndex: p.columnIndex,
            startMin: p.startMin,
            endMin: p.endMin,
            blocks: (pr?.blocks ?? []).map((b) => ({
              eventId: b.eventId,
              coachId: b.coachId,
              startMin: b.startMin,
              endMin: b.endMin,
              locked: wasLocked.has(`${b.eventId}:${b.startMin}:${b.endMin}`),
            })),
          }
        })
        await apiPut(`/api/sessions/${sessionId}/schedule?week=${w}`, { placements })
      }

      // Persist the plan's flags alongside the (unchanged) locks.
      await apiPut(`/api/sessions/${sessionId}/week-locks`, {
        weekLocks: locks,
        planWarnings: result.warnings,
      })

      setCoverage(result.coverage)
      await Promise.all([sessionLoad.reload(), scheduleLoad.reload()])
      setSaveError(null)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'could not generate the plan')
    } finally {
      setGenerating(false)
    }
  }

  const toggleWeekLock = async (w: number) => {
    if (!session) return
    const next = session.weekLocks.map((locked, i) => (i === w - 1 ? !locked : locked))
    try {
      await apiPut(`/api/sessions/${sessionId}/week-locks`, { weekLocks: next })
      await sessionLoad.reload()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'could not change the lock')
    }
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

  /** Press on empty grid inside a class: paint (or erase) a span. */
  const startStroke = (placementId: number, columnIndex: number, e: React.PointerEvent) => {
    if (!tool) return
    const min = minAtPointer(columnIndex, e.clientY)
    if (min === null) return
    e.preventDefault()
    setPointer({ x: e.clientX, y: e.clientY })
    setDrag({ kind: tool.kind, placementId, anchorMin: min, toMin: min })
  }

  /** Press on a block's body: move it whole. Erase tool erases instead. */
  const startMove = (
    placementId: number,
    columnIndex: number,
    blockId: number,
    e: React.PointerEvent,
  ) => {
    e.preventDefault()
    e.stopPropagation()
    setPointer({ x: e.clientX, y: e.clientY })
    if (tool?.kind === 'erase') {
      const min = minAtPointer(columnIndex, e.clientY)
      if (min === null) return
      setDrag({ kind: 'erase', placementId, anchorMin: min, toMin: min })
      return
    }
    const block = schedule?.placements
      .find((p) => p.id === placementId)
      ?.blocks.find((b) => b.id === blockId)
    const min = minAtPointer(columnIndex, e.clientY, true)
    if (!block || min === null) return
    setDrag({
      kind: 'move',
      placementId,
      blockId,
      // Grab the block where it was actually held, so it doesn't jump.
      grabOffsetMin: min - block.startMin,
      toPlacementId: placementId,
      toStartMin: block.startMin,
    })
  }

  const startResize = (
    placementId: number,
    blockId: number,
    edge: 'start' | 'end',
    atMin: number,
    e: React.PointerEvent,
  ) => {
    e.preventDefault()
    e.stopPropagation()
    setPointer({ x: e.clientX, y: e.clientY })
    setDrag({ kind: 'resize', placementId, blockId, edge, toMin: atMin })
  }

  /** The span a paint/erase stroke would write, for the live preview. */
  const strokeSpan = (placementId: number): { from: number; to: number } | null => {
    if (!drag || (drag.kind !== 'paint' && drag.kind !== 'erase')) return null
    if (drag.placementId !== placementId) return null
    const to = drag.toMin === drag.anchorMin ? drag.anchorMin + SLOT_MINUTES : drag.toMin
    return drag.anchorMin < to
      ? { from: drag.anchorMin, to }
      : { from: to, to: drag.anchorMin + SLOT_MINUTES }
  }

  /** Where a block being dragged or resized would end up, and if it's legal. */
  const ghost = (): {
    placementId: number
    startMin: number
    endMin: number
    eventId: number
    fits: boolean
  } | null => {
    if (!drag || !schedule) return null
    if (drag.kind === 'move') {
      const target = moveTarget(
        schedule,
        drag.placementId,
        drag.blockId,
        drag.toPlacementId,
        drag.toStartMin,
      )
      const block = schedule.placements
        .find((p) => p.id === drag.placementId)
        ?.blocks.find((b) => b.id === drag.blockId)
      if (!target || !block) return null
      return { placementId: drag.toPlacementId, ...target, eventId: block.eventId }
    }
    if (drag.kind === 'resize') {
      const placement = schedule.placements.find((p) => p.id === drag.placementId)
      const block = placement?.blocks.find((b) => b.id === drag.blockId)
      const bounds = blockBounds(schedule, drag.placementId, drag.blockId)
      if (!placement || !block || !bounds) return null
      const startMin =
        drag.edge === 'start'
          ? Math.min(Math.max(drag.toMin, bounds.min), block.endMin - SLOT_MINUTES)
          : block.startMin
      const endMin =
        drag.edge === 'end'
          ? Math.max(Math.min(drag.toMin, bounds.max), block.startMin + SLOT_MINUTES)
          : block.endMin
      return { placementId: drag.placementId, startMin, endMin, eventId: block.eventId, fits: true }
    }
    return null
  }

  /** "Beam 16:05–16:20" — what the drag is about to do, follow the cursor. */
  const dragTooltip = (): { text: string; fits: boolean } | null => {
    if (!drag) return null
    const name = (id: number) => eventById.get(id)?.name ?? 'Event'
    const g = ghost()
    if (g) return { text: `${name(g.eventId)} ${formatRange(g.startMin, g.endMin)}`, fits: g.fits }
    const span = strokeSpan(drag.placementId)
    if (!span) return null
    if (drag.kind === 'erase') return { text: `Erase ${formatRange(span.from, span.to)}`, fits: true }
    if (tool?.kind !== 'paint') return null
    return { text: `${name(tool.eventId)} ${formatRange(span.from, span.to)}`, fits: true }
  }

  const tip = dragTooltip()

  return (
    <div className="space-y-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">
            {sessionLabel(session)}
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {formatRange(startMin, endMin)} · repeats weekly · {rows} rows of {SLOT_MINUTES} min
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

      {/* Generate the four-week plan. This slot's classes are already in it
          (derived from their schedules); this palette below is for touching up
          what comes out, week by week. */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-indigo-50 p-4 ring-1 ring-indigo-200 dark:bg-indigo-950 dark:ring-indigo-800">
        <Button
          onClick={() => void generatePlanNow()}
          disabled={schedule.placements.length === 0 || generating}
        >
          {generating ? 'Generating…' : 'Generate 4-week plan'}
        </Button>
        {(schedule.placements.some((p) => p.blocks.length > 0) ||
          session.planWarnings.length > 0) && (
          <Button
            variant="secondary"
            onClick={() => void generatePlanNow()}
            disabled={generating}
            title="Re-randomize; locked weeks and blocks are kept"
          >
            Re-randomize
          </Button>
        )}
        <p className="flex-1 text-sm text-indigo-900 dark:text-indigo-100">
          {schedule.placements.length === 0
            ? 'This slot has no classes yet — give a class this day and start time on the Classes page.'
            : 'Draws each class a fitting subset of its eligible events every week, spreading coverage so each is attended at least twice. Re-randomize re-rolls; locked weeks (🔒) and locked blocks are kept.'}
        </p>
      </div>

      {/* Week switcher: the plan is four grids on the same clock. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">Week</span>
        {Array.from({ length: PLAN_WEEKS }, (_, i) => i + 1).map((w) => {
          const locked = session.weekLocks[w - 1] === true
          const current = w === week
          return (
            <div key={w} className="flex items-center">
              <button
                onClick={() => setWeek(w)}
                aria-pressed={current}
                className={`min-h-10 rounded-l-lg px-3 py-1.5 text-sm font-semibold ring-1 ring-slate-300 dark:ring-slate-600 ${
                  current
                    ? 'bg-indigo-600 text-white'
                    : 'bg-white text-slate-700 hover:bg-slate-50 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600'
                }`}
              >
                {w}
              </button>
              <button
                onClick={() => void toggleWeekLock(w)}
                aria-label={locked ? `unlock week ${w}` : `lock week ${w}`}
                title={locked ? 'Locked — kept when regenerating' : 'Lock this week against regeneration'}
                className={`min-h-10 rounded-r-lg border-l-0 px-2 py-1.5 text-sm ring-1 ring-slate-300 dark:ring-slate-600 ${
                  locked
                    ? 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200'
                    : 'bg-white text-slate-400 hover:bg-slate-50 dark:bg-slate-700 dark:hover:bg-slate-600'
                }`}
              >
                {locked ? '🔒' : '🔓'}
              </button>
            </div>
          )
        })}
        <span className="text-xs text-slate-500 dark:text-slate-400">
          Editing week {week}
          {session.weekLocks[week - 1] ? ' (locked)' : ''}
        </span>
      </div>

      {(coverage !== null || session.planWarnings.length > 0) && (
        <CoveragePanel
          coverage={coverage}
          warnings={session.planWarnings}
          classes={classes}
          events={events}
        />
      )}

      {/* Cleanup tools, secondary to generation. */}
      <details className="rounded-xl bg-white p-3 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700">
        <summary className="cursor-pointer text-sm font-semibold text-slate-700 dark:text-slate-200">
          Edit by hand
          <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
            tweak what was generated — drag a block to move it, its edge to resize
          </span>
        </summary>
        <div className="mt-3 flex flex-wrap items-center gap-2">
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
          Drag empty rows to paint · drag a block to move it · drag its edge to resize
        </span>
        </div>
      </details>

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
            No classes meet in this slot yet. Give a class this day and start time on the{' '}
            <Link className="font-medium text-indigo-600 dark:text-indigo-400" to="/classes">
              Classes
            </Link>{' '}
            page and it appears here as a lane.
          </p>
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
                  <span className="block truncate text-xs font-semibold text-slate-600 dark:text-slate-300">
                    {inLane.length > 0
                      ? inLane.map((p) => classById.get(p.classId)?.name ?? '?').join(' → ')
                      : `Column ${c + 1}`}
                  </span>
                </div>
              )
            })}

            {/* Time column — sticky left, so a wide grid keeps its clock.
                Every 5-minute row is labelled, since every row is a target;
                the hour and half hour are bold so the eye can anchor. */}
            <div
              className="sticky left-0 z-10 border-r border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-700"
              style={{ height: laneHeight(session) }}
            >
              {Array.from({ length: rows }, (_, i) => {
                const label = rowLabel(session, i)
                const hour = label.endsWith(':00')
                const half = label.endsWith(':30')
                return (
                  <div
                    key={i}
                    className={`flex items-start justify-end px-2 tabular-nums ${
                      hour
                        ? 'text-[11px] font-bold text-slate-700 dark:text-slate-200'
                        : half
                          ? 'text-[10px] font-semibold text-slate-600 dark:text-slate-300'
                          : 'text-[10px] text-slate-400 dark:text-slate-500'
                    }`}
                    style={{ height: ROW_H, paddingTop: 1 }}
                  >
                    {hour ? label : `:${label.slice(3)}`}
                  </div>
                )
              })}
            </div>

            {/* Lanes. Rows are drawn as background gradients rather than a div
                per slot, and blocks are absolutely positioned — at 16 lanes
                that is a few hundred nodes instead of many thousand. */}
            {columns.map((c) => (
              <div
                key={c}
                ref={(el) => {
                  if (el) laneRefs.current.set(c, el)
                  else laneRefs.current.delete(c)
                }}
                className="relative border-r border-slate-200 dark:border-slate-700"
                style={{ height: laneHeight(session), ...laneBackground(session) }}
              >
                {schedule.placements
                  .filter((p) => p.columnIndex === c)
                  .map((p) => {
                    const cls = classById.get(p.classId)
                    const placementConflicts = conflicts.placements.get(p.id)
                    const stroke = strokeSpan(p.id)
                    const g = ghost()
                    return (
                      <div
                        key={p.id}
                        data-testid={`placement-${p.id}`}
                        className={`absolute inset-x-0 touch-none ${
                          tool?.kind === 'erase' ? 'cursor-cell' : 'cursor-crosshair'
                        } ${
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
                          // Only bare grid paints. Blocks, handles and the
                          // class header run their own gestures, so the three
                          // never fight over the same press.
                          if ((e.target as HTMLElement).closest('[data-gesture]')) return
                          startStroke(p.id, c, e)
                        }}
                      >
                        {p.blocks.map((b) => {
                          const event = eventById.get(b.eventId)
                          const color = event?.color ?? '#BAB0AC'
                          const reasons = conflicts.blocks.get(b.id)
                          const outage = outageFor(b.eventId, b.coachId)
                          const coach = b.coachId === null ? undefined : coachById.get(b.coachId)
                          const dragging =
                            drag?.kind === 'move' && drag.blockId === b.id && drag.placementId === p.id
                          const resizing =
                            drag?.kind === 'resize' && drag.blockId === b.id && drag.placementId === p.id
                          const tall = spanHeight(b.startMin, b.endMin) >= ROW_H * 2
                          return (
                            <div
                              key={b.id}
                              data-gesture
                              data-testid={`block-${b.eventId}-${b.startMin}`}
                              // Thick top/bottom edges keep the boundary
                              // visible even between two same-colored blocks.
                              // They are an inset shadow rather than a real
                              // border so the resize handles can sit flush
                              // with the block's true edge — with a border,
                              // its outermost pixels belong to the block and
                              // grabbing the very edge moved instead of
                              // resized.
                              className={`group absolute inset-x-0 overflow-hidden shadow-[inset_0_2px_0_rgba(0,0,0,0.45),inset_0_-2px_0_rgba(0,0,0,0.45)] ${
                                tool?.kind === 'erase' ? 'cursor-cell' : 'cursor-grab active:cursor-grabbing'
                              } ${reasons ? 'ring-2 ring-inset ring-red-500' : ''} ${
                                !reasons && outage ? 'ring-2 ring-inset ring-amber-500' : ''
                              } ${b.locked ? 'outline-2 -outline-offset-2 outline-slate-900' : ''} ${
                                dragging || resizing ? 'opacity-40' : ''
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
                                `${event?.name ?? 'Event'} ${formatRange(b.startMin, b.endMin)} — drag to move, drag an edge to resize`
                              }
                              onPointerDown={(e) => startMove(p.id, c, b.id, e)}
                            >
                              {/* Name once at the top of the block; the color
                                  carries through the rest of the span. A block
                                  starting exactly at its class's start drops
                                  its label below the floating class header so
                                  the event name is never hidden by it. */}
                              <div
                                className="flex items-start gap-0.5 px-1"
                                style={{ paddingTop: b.startMin === p.startMin ? 15 : 3 }}
                              >
                                <button
                                  data-gesture
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onClick={() => apply(toggleBlockLock(schedule, p.id, b.id))}
                                  aria-label={b.locked ? `unlock ${event?.name}` : `lock ${event?.name}`}
                                  aria-pressed={b.locked}
                                  className={`shrink-0 text-[10px] leading-none ${b.locked ? '' : 'opacity-40 group-hover:opacity-80'}`}
                                >
                                  {b.locked ? '🔒' : '🔓'}
                                </button>
                                <span className="min-w-0 flex-1 text-[11px] font-semibold leading-tight">
                                  {reasons || outage ? '⚠ ' : ''}
                                  {event?.name ?? 'Unknown'}
                                  {coach && tall && (
                                    <span className="block truncate font-normal opacity-80">
                                      {coach.name}
                                    </span>
                                  )}
                                </span>
                                {/* Delete without switching tools. */}
                                <button
                                  data-gesture
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onClick={() => apply(removeBlock(schedule, p.id, b.id))}
                                  aria-label={`delete ${event?.name ?? 'block'}`}
                                  className="shrink-0 rounded px-0.5 text-[11px] leading-none opacity-0 hover:bg-black/20 focus:opacity-100 group-hover:opacity-70"
                                >
                                  ×
                                </button>
                              </div>

                              {/* Edge handles: drag to lengthen or shorten.
                                  They show a grip on hover so the affordance
                                  is findable, and they are the only part of a
                                  block that resizes rather than moves. */}
                              {(['start', 'end'] as const).map((edge) => (
                                <div
                                  key={edge}
                                  data-gesture
                                  role="slider"
                                  aria-label={`resize ${event?.name ?? 'block'} ${edge}`}
                                  aria-valuenow={edge === 'start' ? b.startMin : b.endMin}
                                  aria-valuemin={p.startMin}
                                  aria-valuemax={p.endMin}
                                  tabIndex={-1}
                                  onPointerDown={(e) =>
                                    startResize(p.id, b.id, edge, edge === 'start' ? b.startMin : b.endMin, e)
                                  }
                                  className={`absolute inset-x-0 flex h-2 cursor-ns-resize touch-none items-center justify-center bg-black/10 hover:bg-black/40 ${
                                    edge === 'start' ? 'top-0' : 'bottom-0'
                                  }`}
                                >
                                  <span className="h-0.5 w-6 rounded-full bg-white/70 opacity-0 group-hover:opacity-100" />
                                </div>
                              ))}
                            </div>
                          )
                        })}

                        {/* Class header: name + its own window, floated over
                            the top of the class's block. It deliberately does
                            not occupy a row: a 5-minute row spent on a label
                            would push the first event block down and misreport
                            its time, and the axis has to stay honest. */}
                        {/* The strip itself is transparent to the pointer and
                            only the label catches clicks, so the header does
                            not steal the top resize handle of a block that
                            starts at the class's own start. */}
                        <div className="pointer-events-none absolute left-0 right-0 top-0 z-[5] flex">
                          <span
                            title={`${cls?.name ?? 'Unknown class'} ${formatRange(p.startMin, p.endMin)}`}
                            className={`max-w-full truncate px-1 text-left text-[10px] font-bold leading-tight ring-1 ring-black/20 ${
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
                          </span>
                        </div>

                        {/* Live preview: the span a stroke would write… */}
                        {stroke && tool && (
                          <div
                            className="pointer-events-none absolute inset-x-0 z-[6] opacity-70 ring-2 ring-slate-900 dark:ring-slate-100"
                            style={{
                              top: minToY(session, stroke.from) - minToY(session, p.startMin),
                              height: spanHeight(stroke.from, stroke.to),
                              backgroundColor:
                                tool.kind === 'paint'
                                  ? (eventById.get(tool.eventId)?.color ?? '#888')
                                  : 'transparent',
                            }}
                          />
                        )}
                        {/* …or where a moved/resized block would land. Red
                            when it would collide, so a refused drop is
                            obvious before the mouse comes up. */}
                        {g && g.placementId === p.id && (
                          <div
                            className={`pointer-events-none absolute inset-x-0 z-[6] opacity-80 ring-2 ${
                              g.fits ? 'ring-slate-900 dark:ring-slate-100' : 'ring-red-500'
                            }`}
                            style={{
                              top: minToY(session, g.startMin) - minToY(session, p.startMin),
                              height: spanHeight(g.startMin, g.endMin),
                              backgroundColor: g.fits
                                ? (eventById.get(g.eventId)?.color ?? '#888')
                                : 'rgba(239,68,68,0.35)',
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

      {/* What the drag is about to do, following the cursor. */}
      {tip && pointer && (
        <div
          role="status"
          className={`pointer-events-none fixed z-50 rounded-md px-2 py-1 text-xs font-semibold tabular-nums text-white shadow-lg ${
            tip.fits ? 'bg-slate-900 dark:bg-slate-700' : 'bg-red-600'
          }`}
          style={{ left: pointer.x + 14, top: pointer.y + 14 }}
        >
          {tip.text}
          {!tip.fits && ' — blocked'}
        </div>
      )}

    </div>
  )
}

/**
 * The plan's coverage at a glance: per class, how many times each eligible
 * event is attended across the four weeks, and the plain-language flags for
 * anything that fell short. Warnings persist with the session; the per-event
 * grid only appears right after a generation.
 */
function CoveragePanel({
  coverage,
  warnings,
  classes,
  events,
}: {
  coverage: ClassCoverage[] | null
  warnings: string[]
  classes: GymClass[]
  events: GymEvent[]
}) {
  const classById = new Map(classes.map((c) => [c.id, c]))
  const eventById = new Map(events.map((e) => [e.id, e]))
  return (
    <div className="rounded-xl bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700">
      <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
        Coverage across the four weeks
      </h2>
      {warnings.length > 0 && (
        <ul className="mb-3 space-y-1">
          {warnings.map((w, i) => (
            <li key={i} className="text-sm font-medium text-amber-700 dark:text-amber-300">
              ⚠ {w}
            </li>
          ))}
        </ul>
      )}
      {coverage === null ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Regenerate to see each class's per-event visit counts.
        </p>
      ) : (
        <div className="space-y-2">
          {coverage.map((cls) => (
            <div key={cls.classId} className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                {classById.get(cls.classId)?.name ?? `class #${cls.classId}`}
              </span>
              {cls.events.length === 0 && (
                <span className="text-sm text-slate-400 dark:text-slate-500">no eligible events</span>
              )}
              {cls.events.map((cov) => (
                <span
                  key={cov.eventId}
                  className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                    cov.short
                      ? 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200'
                      : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200'
                  }`}
                  title={cov.short ? 'below the target of 2 visits' : undefined}
                >
                  {eventById.get(cov.eventId)?.name ?? `#${cov.eventId}`}: {cov.visits}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
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
