import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { Assignment, Coach, GymClass, GymEvent, Session, Settings } from '../../shared/types.ts'
import { slotCount, slotStart } from '../../shared/slots.ts'
import { formatDateLong } from '../../shared/dates.ts'
import { apiGet, apiPut } from '../lib/api.ts'
import { useLoad } from '../lib/useLoad.ts'
import { CONFLICT_LABELS, assignmentKey, findConflicts } from '../lib/conflicts.ts'
import { classColor } from '../lib/colors.ts'
import { textColorFor } from '../../shared/colors.ts'
import { generateSchedule } from '../solver/solver.ts'
import { describeRepairChanges, repairSchedule } from '../solver/repair.ts'
import {
  Button,
  Card,
  ChipPicker,
  ErrorNote,
  Field,
  FieldGroup,
  PageHeader,
  Select,
} from '../components/ui.tsx'
import { CopySessionDialog } from '../components/CopySessionDialog.tsx'
import { sessionLabel } from '../lib/sessions.ts'

type SaveState = 'saved' | 'saving' | 'error'
type ViewMode = 'events' | 'classes'

/** Where the user clicked: a slot plus the fixed row (event or class). */
interface PickerTarget {
  slotIndex: number
  eventId?: number
  classId?: number
}

function AssignmentPicker({
  target,
  session,
  events,
  classes,
  coaches,
  onAdd,
  onClose,
}: {
  target: PickerTarget
  session: Session
  events: GymEvent[]
  classes: GymClass[]
  coaches: Coach[]
  onAdd: (a: Assignment) => void
  onClose: () => void
}) {
  const sessionClasses = classes.filter((g) => session.classes.includes(g.id))
  const activeEvents = events.filter((e) => e.active)
  const needsClass = target.classId === undefined
  const needsEvent = target.eventId === undefined

  const [classId, setClassId] = useState<number | undefined>(
    target.classId ?? sessionClasses[0]?.id,
  )
  const [eventId, setEventId] = useState<number | undefined>(target.eventId ?? activeEvents[0]?.id)
  const cls = classes.find((g) => g.id === classId)
  const [coachId, setCoachId] = useState<number | ''>('')

  // Default to the class's first assigned coach whenever the class changes.
  useEffect(() => {
    setCoachId(cls?.assignedCoaches[0] ?? '')
  }, [cls])

  const sortedCoaches = [...coaches].sort((a, b) => {
    const aAssigned = cls?.assignedCoaches.includes(a.id) ? 0 : 1
    const bAssigned = cls?.assignedCoaches.includes(b.id) ? 0 : 1
    return aAssigned - bAssigned || a.name.localeCompare(b.name)
  })

  const eventName = events.find((e) => e.id === target.eventId)?.name
  const title = [
    eventName ?? classes.find((g) => g.id === target.classId)?.name,
    `at ${slotStart(session, target.slotIndex)}`,
  ].join(' ')

  return (
    <div
      className="fixed inset-0 z-10 flex items-end justify-center bg-black/30 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm space-y-3 rounded-xl bg-white p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-semibold text-slate-900">Assign — {title}</h2>
        {needsClass && (
          <Field label="Class">
            <Select value={classId ?? ''} onChange={(e) => setClassId(Number(e.target.value))}>
              {sessionClasses.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {needsEvent && (
          <Field label="Event">
            <Select value={eventId ?? ''} onChange={(e) => setEventId(Number(e.target.value))}>
              {activeEvents.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Coach (optional)">
          <Select
            value={coachId}
            onChange={(e) => setCoachId(e.target.value === '' ? '' : Number(e.target.value))}
          >
            <option value="">No coach</option>
            {sortedCoaches.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {cls?.assignedCoaches.includes(c.id) ? ' (assigned)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex gap-2">
          <Button
            disabled={classId === undefined || eventId === undefined}
            onClick={() => {
              if (classId === undefined || eventId === undefined) return
              onAdd({
                slotIndex: target.slotIndex,
                eventId,
                classId,
                coachId: coachId === '' ? null : coachId,
              })
              onClose()
            }}
          >
            Add to schedule
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}

function Chip({
  label,
  sub,
  colorClass,
  customColor,
  conflictReasons,
  locked,
  outage,
  blockStart = false,
  onToggleLock,
  onRemove,
}: {
  label: string
  sub?: string
  colorClass: string
  /** Inline hex background (event color); overrides colorClass when set. */
  customColor?: string
  conflictReasons: string[] | undefined
  locked: boolean
  /** Day-of outage affecting this cell ("Dana Marsh is out today"). */
  outage?: string
  /** First cell of a multi-slot block: draws a strong top edge. */
  blockStart?: boolean
  onToggleLock: () => void
  onRemove: () => void
}) {
  const conflicted = conflictReasons !== undefined && conflictReasons.length > 0
  const style =
    !conflicted && customColor
      ? { backgroundColor: customColor, color: textColorFor(customColor) }
      : undefined
  return (
    <span
      title={conflicted ? conflictReasons.join('; ') : outage}
      style={style}
      className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium ring-1 ${
        conflicted
          ? 'bg-red-100 text-red-900 ring-2 ring-red-500'
          : customColor
            ? 'ring-black/10'
            : colorClass
      } ${!conflicted && outage ? 'ring-2 ring-amber-500' : ''} ${
        locked ? 'outline-2 -outline-offset-1 outline-slate-800' : ''
      } ${blockStart ? 'shadow-[inset_0_3px_0_rgba(0,0,0,0.3)]' : ''}`}
    >
      <button
        onClick={onToggleLock}
        aria-label={locked ? `unlock ${label}` : `lock ${label}`}
        aria-pressed={locked}
        title={locked ? 'Unlock — generation may move this' : 'Lock — generation keeps this in place'}
        className={`shrink-0 rounded px-0.5 text-[11px] leading-none hover:bg-black/10 ${
          locked ? '' : 'opacity-40 hover:opacity-100'
        }`}
      >
        {locked ? '🔒' : '🔓'}
      </button>
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          {conflicted || outage ? `⚠ ${label}` : label}
        </span>
        {sub && <span className="block truncate font-normal opacity-75">{sub}</span>}
      </span>
      {!locked && (
        <button
          onClick={onRemove}
          aria-label={`remove ${label}`}
          className="shrink-0 rounded px-1 text-sm leading-none opacity-60 hover:bg-black/10 hover:opacity-100"
        >
          ×
        </button>
      )}
    </span>
  )
}

export function SchedulePage() {
  const params = useParams()
  const sessionId = Number(params.id)
  const [searchParams, setSearchParams] = useSearchParams()
  const showWelcome = searchParams.get('welcome') === '1'
  const navigate = useNavigate()
  const [copyOpen, setCopyOpen] = useState(false)

  const sessionLoad = useLoad(() => apiGet<{ session: Session }>(`/api/sessions/${sessionId}`))
  const eventsLoad = useLoad(() => apiGet<{ events: GymEvent[] }>('/api/events'))
  const classesLoad = useLoad(() => apiGet<{ classes: GymClass[] }>('/api/classes'))
  const coachesLoad = useLoad(() => apiGet<{ coaches: Coach[] }>('/api/coaches'))
  const assignmentsLoad = useLoad(() =>
    apiGet<{ assignments: Assignment[] }>(`/api/sessions/${sessionId}/assignments`),
  )
  const settingsLoad = useLoad(() => apiGet<{ settings: Settings }>('/api/settings'))

  const [assignments, setAssignments] = useState<Assignment[] | null>(null)
  const [view, setView] = useState<ViewMode>('events')
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [picker, setPicker] = useState<PickerTarget | null>(null)
  const [generationErrors, setGenerationErrors] = useState<string[] | null>(null)
  const [repairSummary, setRepairSummary] = useState<string[] | null>(null)

  useEffect(() => {
    if (assignmentsLoad.data) setAssignments(assignmentsLoad.data.assignments)
  }, [assignmentsLoad.data])

  const session = sessionLoad.data?.session
  const events = eventsLoad.data?.events ?? []
  const classes = classesLoad.data?.classes ?? []
  const coaches = coachesLoad.data?.coaches ?? []

  const conflicts = useMemo(
    () => findConflicts(assignments ?? [], events),
    [assignments, events],
  )

  async function persist(next: Assignment[]) {
    const previous = assignments
    setAssignments(next)
    setSaveState('saving')
    try {
      await apiPut(`/api/sessions/${sessionId}/assignments`, { assignments: next })
      setSaveState('saved')
      setSaveError(null)
    } catch (err) {
      setAssignments(previous)
      setSaveState('error')
      setSaveError(err instanceof Error ? err.message : 'could not save')
    }
  }

  const loadError =
    sessionLoad.error ??
    eventsLoad.error ??
    classesLoad.error ??
    coachesLoad.error ??
    assignmentsLoad.error ??
    settingsLoad.error
  if (loadError) return <ErrorNote message={loadError} />
  if (!session || assignments === null) return null

  const slots = slotCount(session)
  const slotIndexes = Array.from({ length: slots }, (_, i) => i)
  const sessionClasses = classes.filter((g) => session.classes.includes(g.id))
  const rowEvents = events.filter((e) => e.active || assignments.some((a) => a.eventId === e.id))
  const classNameOf = (id: number) => classes.find((g) => g.id === id)?.name ?? 'deleted class'
  const eventNameOf = (id: number) => events.find((e) => e.id === id)?.name ?? 'deleted event'
  const eventColorOf = (id: number) => events.find((e) => e.id === id)?.color
  const coachName = (id: number | null) =>
    id === null ? undefined : (coaches.find((c) => c.id === id)?.name ?? 'deleted coach')

  const remove = (target: Assignment) =>
    persist(assignments.filter((a) => assignmentKey(a) !== assignmentKey(target)))

  const add = (a: Assignment) => {
    if (assignments.some((x) => assignmentKey(x) === assignmentKey(a))) return
    void persist([...assignments, a])
  }

  const toggleLock = (target: Assignment) =>
    persist(
      assignments.map((a) =>
        assignmentKey(a) === assignmentKey(target) ? { ...a, locked: !a.locked } : a,
      ),
    )

  // A "block" is a run of consecutive slots where a class stays on the same
  // event with the same coach. The By classes view renders blocks — label on
  // the first cell, color carried through — and lock/remove act block-wide.
  const sameCell = (a: Assignment, classId: number, slotIndex: number) =>
    a.classId === classId && a.slotIndex === slotIndex
  const continuesFromPrev = (a: Assignment) =>
    assignments.some(
      (x) =>
        sameCell(x, a.classId, a.slotIndex - 1) &&
        x.eventId === a.eventId &&
        x.coachId === a.coachId,
    )
  const blockRun = (start: Assignment): Assignment[] => {
    const run = [start]
    for (let s = start.slotIndex + 1; ; s++) {
      const next = assignments.find(
        (x) => sameCell(x, start.classId, s) && x.eventId === start.eventId && x.coachId === start.coachId,
      )
      if (!next) break
      run.push(next)
    }
    return run
  }
  const removeBlock = (start: Assignment) => {
    const keys = new Set(blockRun(start).map(assignmentKey))
    return persist(assignments.filter((a) => !keys.has(assignmentKey(a))))
  }
  const toggleLockBlock = (start: Assignment) => {
    const keys = new Set(blockRun(start).map(assignmentKey))
    const to = !start.locked
    return persist(
      assignments.map((a) => (keys.has(assignmentKey(a)) ? { ...a, locked: to } : a)),
    )
  }

  // Generate ("Shuffle" is the same with a fresh seed): locked cells are
  // kept and solved around; unlocked ones are replaced after a warning.
  const generate = () => {
    if (!session || !settingsLoad.data) return
    const locks = assignments.filter((a) => a.locked)
    const unlockedCount = assignments.length - locks.length
    if (
      unlockedCount > 0 &&
      !confirm(
        `Replace ${unlockedCount} unlocked assignment${unlockedCount === 1 ? '' : 's'}? ` +
          `Locked cells (🔒) are kept. Lock anything you want to survive first.`,
      )
    ) {
      return
    }
    const result = generateSchedule({
      events: events.map(({ id, name, capacity, active }) => ({ id, name, capacity, active })),
      classes: sessionClasses.map(({ id, name, priority, requiredEvents, assignedCoaches }) => ({
        id,
        name,
        priority,
        requiredEvents,
        assignedCoaches,
      })),
      coaches: coaches.map(({ id, name, specialties }) => ({ id, name, specialties })),
      slotCount: slots,
      rotationLength: session.rotationLength,
      coachMode: settingsLoad.data.settings.coachMode,
      adjacencyPenalties: settingsLoad.data.settings.adjacencyPenalties,
      locked: locks,
      seed: Math.floor(Math.random() * 2 ** 31),
    })
    if (result.ok) {
      setGenerationErrors(null)
      void persist(result.assignments)
    } else {
      setGenerationErrors(result.reasons)
    }
  }

  // --- Day-of changes: session-scoped outages + minimal-disruption repair.
  const absentSet = new Set(session.absentCoaches)
  const downSet = new Set(session.unavailableEvents)
  const outagesActive = absentSet.size > 0 || downSet.size > 0
  const outageReasonFor = (a: Assignment): string | undefined => {
    if (downSet.has(a.eventId)) return `${eventNameOf(a.eventId)} is out today`
    if (a.coachId !== null && absentSet.has(a.coachId))
      return `${coachName(a.coachId)} is out today`
    return undefined
  }
  const affectedCount = assignments.filter((a) => outageReasonFor(a) !== undefined).length

  const setOutages = async (absentCoaches: number[], unavailableEvents: number[]) => {
    try {
      await apiPut(`/api/sessions/${sessionId}/outages`, { absentCoaches, unavailableEvents })
      setSaveError(null)
      await sessionLoad.reload()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'could not save outages')
    }
  }

  const repair = () => {
    if (!settingsLoad.data) return
    const result = repairSchedule({
      events: events.map(({ id, name, capacity, active }) => ({ id, name, capacity, active })),
      classes: sessionClasses.map(({ id, name, priority, requiredEvents, assignedCoaches }) => ({
        id,
        name,
        priority,
        requiredEvents,
        assignedCoaches,
      })),
      coaches: coaches.map(({ id, name, specialties }) => ({ id, name, specialties })),
      slotCount: slots,
      rotationLength: session.rotationLength,
      coachMode: settingsLoad.data.settings.coachMode,
      adjacencyPenalties: settingsLoad.data.settings.adjacencyPenalties,
      original: assignments,
      absentCoachIds: session.absentCoaches,
      unavailableEventIds: session.unavailableEvents,
      seed: Math.floor(Math.random() * 2 ** 31),
    })
    if (result.ok) {
      setRepairSummary(
        describeRepairChanges(result.changes, {
          events,
          classes,
          coaches,
          startTime: session.startTime,
          rotationLength: session.rotationLength,
        }),
      )
      setGenerationErrors(null)
      void persist(result.assignments)
    } else {
      setGenerationErrors(result.reasons)
      setRepairSummary(null)
    }
  }

  const conflictCount = conflicts.size

  // By classes view: block-aware cells. The first slot of a block gets the
  // full chip (acting on the whole block); continuations are color-only.
  const classCell = (cls: GymClass, slotIndex: number) => {
    const here = assignments.filter((a) => sameCell(a, cls.id, slotIndex))
    const target: PickerTarget = { slotIndex, classId: cls.id }
    const conflicted = here.some((a) => conflicts.has(assignmentKey(a)))
    const key = `${slotIndex}:g${cls.id}`

    if (here.length > 0 && here.every(continuesFromPrev)) {
      const a = here[0]!
      const color = conflicted ? undefined : eventColorOf(a.eventId)
      const locked = here.some((x) => x.locked)
      const outage = outageReasonFor(a)
      return (
        <td
          key={key}
          className={`min-w-28 rounded-lg p-1 align-top ring-1 ${
            conflicted ? 'bg-red-50 ring-red-400' : 'bg-white ring-slate-200'
          }`}
        >
          <div
            title={outage ?? `${eventNameOf(a.eventId)} (continued)`}
            style={color ? { backgroundColor: color } : undefined}
            className={`min-h-12 rounded-md ${
              conflicted
                ? 'bg-red-100 ring-2 ring-red-500'
                : outage
                  ? 'ring-2 ring-amber-500'
                  : 'ring-1 ring-black/10'
            } ${locked ? 'outline-2 -outline-offset-1 outline-slate-800' : ''}`}
          />
        </td>
      )
    }

    return (
      <td
        key={key}
        className={`min-w-28 rounded-lg p-1 align-top ring-1 ${
          conflicted ? 'bg-red-50 ring-red-400' : 'bg-white ring-slate-200'
        }`}
      >
        <div className="flex min-h-12 flex-col gap-1">
          {here.map((a) => (
            <Chip
              key={assignmentKey(a)}
              label={eventNameOf(a.eventId)}
              sub={coachName(a.coachId)}
              colorClass={classColor(a.classId)}
              customColor={eventColorOf(a.eventId)}
              blockStart
              conflictReasons={conflicts.get(assignmentKey(a))?.map((r) => CONFLICT_LABELS[r])}
              locked={a.locked ?? false}
              outage={outageReasonFor(a)}
              onToggleLock={() => void toggleLockBlock(a)}
              onRemove={() => void removeBlock(a)}
            />
          ))}
          {here.length === 0 && (
            <button
              onClick={() => setPicker(target)}
              aria-label="assign here"
              className="min-h-6 flex-1 rounded text-sm text-slate-300 hover:bg-slate-100 hover:text-slate-500"
            >
              +
            </button>
          )}
        </div>
      </td>
    )
  }

  function cellFor(list: Assignment[], target: PickerTarget, labelOf: (a: Assignment) => string) {
    const conflicted = list.some((a) => conflicts.has(assignmentKey(a)))
    return (
      <td
        key={`${target.slotIndex}:${target.eventId ?? 'g'}:${target.classId ?? 'e'}`}
        className={`min-w-28 rounded-lg p-1 align-top ring-1 ${
          conflicted ? 'bg-red-50 ring-red-400' : 'bg-white ring-slate-200'
        }`}
      >
        <div className="flex min-h-12 flex-col gap-1">
          {list.map((a) => (
            <Chip
              key={assignmentKey(a)}
              label={labelOf(a)}
              sub={coachName(a.coachId)}
              colorClass={classColor(a.classId)}
              // In the By classes view the chip answers "which event?", so it
              // wears the event color; in By Events view the column already
              // is the event, so chips keep class colors.
              customColor={target.classId !== undefined ? eventColorOf(a.eventId) : undefined}
              conflictReasons={conflicts
                .get(assignmentKey(a))
                ?.map((r) => CONFLICT_LABELS[r])}
              locked={a.locked ?? false}
              outage={outageReasonFor(a)}
              onToggleLock={() => void toggleLock(a)}
              onRemove={() => void remove(a)}
            />
          ))}
          <button
            onClick={() => setPicker(target)}
            aria-label="assign here"
            className="min-h-6 flex-1 rounded text-sm text-slate-300 hover:bg-slate-100 hover:text-slate-500"
          >
            +
          </button>
        </div>
      </td>
    )
  }

  return (
    <div className="space-y-4">
      {showWelcome && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-indigo-50 p-4 ring-1 ring-indigo-200">
          <p className="flex-1 text-sm text-indigo-900">
            🎉 <span className="font-semibold">Setup complete</span> — this is your schedule
            grid. Hit <span className="font-semibold">Generate schedule</span> to auto-fill the
            rotation, or tap any <span className="font-semibold">+</span> cell to assign a class
            manually.
          </p>
          <Button variant="secondary" onClick={() => setSearchParams({}, { replace: true })}>
            Got it
          </Button>
        </div>
      )}
      <PageHeader title={sessionLabel(session)}>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setCopyOpen(true)}
            className="min-h-10 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
          >
            Copy session
          </button>
          <Link
            to={`/sessions/${sessionId}/print`}
            className="min-h-10 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
          >
            Print
          </Link>
          <a
            href={`/api/sessions/${sessionId}/export`}
            download
            className="min-h-10 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
          >
            Export to Excel
          </a>
          <span
            className={`text-sm ${
              saveState === 'error' ? 'font-medium text-red-600' : 'text-slate-500'
            }`}
          >
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : 'Save failed'}
          </span>
          <div className="flex rounded-lg bg-slate-200 p-0.5">
            {(['events', 'classes'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setView(mode)}
                className={`min-h-10 rounded-md px-3 py-1.5 text-sm font-medium capitalize ${
                  view === mode ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                By {mode}
              </button>
            ))}
          </div>
        </div>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-3">
        {sessionClasses.length > 0 && (
          <>
            <Button onClick={generate}>Generate schedule</Button>
            {assignments.length > 0 && (
              <Button variant="secondary" onClick={generate} title="Regenerate with a new seed">
                Shuffle
              </Button>
            )}
          </>
        )}
        <p className="text-sm text-slate-500">
          {formatDateLong(session.date)} · {session.startTime}–{session.endTime} · {slots}{' '}
          rotations of {session.rotationLength} min
          {conflictCount > 0 && (
            <span className="ml-2 font-medium text-red-600">
              ⚠ {conflictCount} conflicting assignment{conflictCount === 1 ? '' : 's'}
            </span>
          )}
        </p>
      </div>
      <ErrorNote message={saveError} />

      <details
        open={outagesActive}
        className="rounded-xl bg-white p-4 ring-1 ring-slate-200"
      >
        <summary className="cursor-pointer text-sm font-semibold text-slate-700">
          Day-of changes
          {affectedCount > 0 && (
            <span className="ml-2 font-medium text-amber-600">
              ⚠ {affectedCount} assignment{affectedCount === 1 ? '' : 's'} affected
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
              options={events
                .filter((e) => e.active)
                .map((e) => ({ id: e.id, label: e.name }))}
              selected={session.unavailableEvents}
              onChange={(ids) => void setOutages(session.absentCoaches, ids)}
            />
          </FieldGroup>
          {outagesActive && (
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={repair}>Repair schedule</Button>
              <p className="text-sm text-slate-500">
                Keeps everything unaffected in place; only fixes what the outage touches.
              </p>
            </div>
          )}
        </div>
      </details>

      {repairSummary && (
        <div role="status" className="rounded-xl bg-emerald-50 p-4 ring-1 ring-emerald-200">
          <div className="flex items-start justify-between gap-2">
            <p className="font-semibold text-emerald-900">Schedule repaired</p>
            <button
              onClick={() => setRepairSummary(null)}
              aria-label="dismiss"
              className="rounded px-1 text-emerald-400 hover:bg-emerald-100 hover:text-emerald-700"
            >
              ×
            </button>
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-emerald-900">
            {repairSummary.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {generationErrors && (
        <div role="alert" className="rounded-xl bg-red-50 p-4 ring-1 ring-red-200">
          <div className="flex items-start justify-between gap-2">
            <p className="font-semibold text-red-800">Couldn't generate a schedule</p>
            <button
              onClick={() => setGenerationErrors(null)}
              aria-label="dismiss"
              className="rounded px-1 text-red-400 hover:bg-red-100 hover:text-red-700"
            >
              ×
            </button>
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-red-700">
            {generationErrors.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      {sessionClasses.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-600">
            This session has no classes yet.{' '}
            <Link className="font-medium text-indigo-600" to="/sessions">
              Edit the session
            </Link>{' '}
            to add the classes that attend, then build the rotation here.
          </p>
        </Card>
      ) : (
        <div className="overflow-x-auto pb-2">
          {/* Day-planner orientation: events (or classes) across the top,
              time slots down the left. */}
          <table className="border-separate border-spacing-1">
            <thead>
              <tr>
                <th className="sticky left-0 z-[5] w-16 bg-slate-100 p-1 text-left text-xs font-semibold text-slate-500">
                  Time
                </th>
                {view === 'events'
                  ? rowEvents.map((event) => (
                      <th
                        key={event.id}
                        className="min-w-28 p-1 text-left text-sm font-semibold text-slate-800"
                      >
                        {event.name}
                        {!event.active && (
                          <span className="block text-xs font-normal text-red-500">inactive</span>
                        )}
                        {downSet.has(event.id) && (
                          <span className="block text-xs font-normal text-amber-600">
                            ⚠ out today
                          </span>
                        )}
                        {event.capacity !== null && event.capacity > 1 && (
                          <span className="block text-xs font-normal text-slate-500">
                            fits {event.capacity}
                          </span>
                        )}
                        <span
                          className="mt-1 block h-1.5 rounded-full"
                          style={{ backgroundColor: event.color }}
                        />
                      </th>
                    ))
                  : sessionClasses.map((cls) => (
                      <th
                        key={cls.id}
                        className="min-w-28 p-1 text-left text-sm font-semibold text-slate-800"
                      >
                        {cls.name}
                      </th>
                    ))}
              </tr>
            </thead>
            <tbody>
              {slotIndexes.map((slotIndex) => (
                <tr key={slotIndex}>
                  <th className="sticky left-0 z-[5] bg-slate-100 p-1 text-left align-top text-xs font-semibold text-slate-500">
                    {slotStart(session, slotIndex)}
                  </th>
                  {view === 'events'
                    ? rowEvents.map((event) =>
                        cellFor(
                          assignments.filter(
                            (a) => a.eventId === event.id && a.slotIndex === slotIndex,
                          ),
                          { slotIndex, eventId: event.id },
                          (a) => classNameOf(a.classId),
                        ),
                      )
                    : sessionClasses.map((cls) => classCell(cls, slotIndex))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {copyOpen && (
        <CopySessionDialog
          session={session}
          onClose={() => setCopyOpen(false)}
          onCopied={(newId) => navigate(`/sessions/${newId}/schedule`)}
        />
      )}
      {picker && session && (
        <AssignmentPicker
          target={picker}
          session={session}
          events={events}
          classes={classes}
          coaches={coaches}
          onAdd={add}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  )
}
