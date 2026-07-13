import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Assignment, Coach, Group, GymEvent, Session, Settings } from '../../shared/types.ts'
import { slotCount, slotStart } from '../../shared/slots.ts'
import { DAY_NAMES, apiGet, apiPut } from '../lib/api.ts'
import { useLoad } from '../lib/useLoad.ts'
import { CONFLICT_LABELS, assignmentKey, findConflicts } from '../lib/conflicts.ts'
import { groupColor } from '../lib/colors.ts'
import { textColorFor } from '../../shared/colors.ts'
import { generateSchedule } from '../solver/solver.ts'
import { Button, Card, ErrorNote, Field, PageHeader, Select } from '../components/ui.tsx'
import { sessionLabel } from './SessionsPage.tsx'

type SaveState = 'saved' | 'saving' | 'error'
type ViewMode = 'events' | 'groups'

/** Where the user clicked: a slot plus the fixed row (event or group). */
interface PickerTarget {
  slotIndex: number
  eventId?: number
  groupId?: number
}

function AssignmentPicker({
  target,
  session,
  events,
  groups,
  coaches,
  onAdd,
  onClose,
}: {
  target: PickerTarget
  session: Session
  events: GymEvent[]
  groups: Group[]
  coaches: Coach[]
  onAdd: (a: Assignment) => void
  onClose: () => void
}) {
  const sessionGroups = groups.filter((g) => session.groups.includes(g.id))
  const activeEvents = events.filter((e) => e.active)
  const needsGroup = target.groupId === undefined
  const needsEvent = target.eventId === undefined

  const [groupId, setGroupId] = useState<number | undefined>(
    target.groupId ?? sessionGroups[0]?.id,
  )
  const [eventId, setEventId] = useState<number | undefined>(target.eventId ?? activeEvents[0]?.id)
  const group = groups.find((g) => g.id === groupId)
  const [coachId, setCoachId] = useState<number | ''>('')

  // Default to the group's first assigned coach whenever the group changes.
  useEffect(() => {
    setCoachId(group?.assignedCoaches[0] ?? '')
  }, [group])

  const sortedCoaches = [...coaches].sort((a, b) => {
    const aAssigned = group?.assignedCoaches.includes(a.id) ? 0 : 1
    const bAssigned = group?.assignedCoaches.includes(b.id) ? 0 : 1
    return aAssigned - bAssigned || a.name.localeCompare(b.name)
  })

  const eventName = events.find((e) => e.id === target.eventId)?.name
  const title = [
    eventName ?? groups.find((g) => g.id === target.groupId)?.name,
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
        {needsGroup && (
          <Field label="Group">
            <Select value={groupId ?? ''} onChange={(e) => setGroupId(Number(e.target.value))}>
              {sessionGroups.map((g) => (
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
                {group?.assignedCoaches.includes(c.id) ? ' (assigned)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex gap-2">
          <Button
            disabled={groupId === undefined || eventId === undefined}
            onClick={() => {
              if (groupId === undefined || eventId === undefined) return
              onAdd({
                slotIndex: target.slotIndex,
                eventId,
                groupId,
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
      title={conflicted ? conflictReasons.join('; ') : undefined}
      style={style}
      className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium ring-1 ${
        conflicted
          ? 'bg-red-100 text-red-900 ring-2 ring-red-500'
          : customColor
            ? 'ring-black/10'
            : colorClass
      } ${locked ? 'outline-2 -outline-offset-1 outline-slate-800' : ''}`}
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
        <span className="block truncate">{conflicted ? `⚠ ${label}` : label}</span>
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

  const sessionLoad = useLoad(() => apiGet<{ session: Session }>(`/api/sessions/${sessionId}`))
  const eventsLoad = useLoad(() => apiGet<{ events: GymEvent[] }>('/api/events'))
  const groupsLoad = useLoad(() => apiGet<{ groups: Group[] }>('/api/groups'))
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

  useEffect(() => {
    if (assignmentsLoad.data) setAssignments(assignmentsLoad.data.assignments)
  }, [assignmentsLoad.data])

  const session = sessionLoad.data?.session
  const events = eventsLoad.data?.events ?? []
  const groups = groupsLoad.data?.groups ?? []
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
    groupsLoad.error ??
    coachesLoad.error ??
    assignmentsLoad.error ??
    settingsLoad.error
  if (loadError) return <ErrorNote message={loadError} />
  if (!session || assignments === null) return null

  const slots = slotCount(session)
  const slotIndexes = Array.from({ length: slots }, (_, i) => i)
  const sessionGroups = groups.filter((g) => session.groups.includes(g.id))
  const rowEvents = events.filter((e) => e.active || assignments.some((a) => a.eventId === e.id))
  const groupName = (id: number) => groups.find((g) => g.id === id)?.name ?? 'deleted group'
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
      groups: sessionGroups.map(({ id, name, priority, requiredEvents, assignedCoaches }) => ({
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

  const conflictCount = conflicts.size

  function cellFor(list: Assignment[], target: PickerTarget, labelOf: (a: Assignment) => string) {
    const conflicted = list.some((a) => conflicts.has(assignmentKey(a)))
    return (
      <td
        key={`${target.slotIndex}:${target.eventId ?? 'g'}:${target.groupId ?? 'e'}`}
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
              colorClass={groupColor(a.groupId)}
              // In the By Groups view the chip answers "which event?", so it
              // wears the event color; in By Events view the column already
              // is the event, so chips keep group colors.
              customColor={target.groupId !== undefined ? eventColorOf(a.eventId) : undefined}
              conflictReasons={conflicts
                .get(assignmentKey(a))
                ?.map((r) => CONFLICT_LABELS[r])}
              locked={a.locked ?? false}
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
      <PageHeader title={sessionLabel(session)}>
        <div className="flex items-center gap-3">
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
            {(['events', 'groups'] as const).map((mode) => (
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
        {sessionGroups.length > 0 && (
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
          {DAY_NAMES[session.dayOfWeek]} {session.startTime}–{session.endTime} · {slots} rotations
          of {session.rotationLength} min
          {conflictCount > 0 && (
            <span className="ml-2 font-medium text-red-600">
              ⚠ {conflictCount} conflicting assignment{conflictCount === 1 ? '' : 's'}
            </span>
          )}
        </p>
      </div>
      <ErrorNote message={saveError} />
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

      {sessionGroups.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-600">
            This session has no groups yet.{' '}
            <Link className="font-medium text-indigo-600" to="/sessions">
              Edit the session
            </Link>{' '}
            to add the groups that attend, then build the rotation here.
          </p>
        </Card>
      ) : (
        <div className="overflow-x-auto pb-2">
          {/* Day-planner orientation: events (or groups) across the top,
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
                        {event.capacity > 1 && (
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
                  : sessionGroups.map((group) => (
                      <th
                        key={group.id}
                        className="min-w-28 p-1 text-left text-sm font-semibold text-slate-800"
                      >
                        {group.name}
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
                          (a) => groupName(a.groupId),
                        ),
                      )
                    : sessionGroups.map((group) =>
                        cellFor(
                          assignments.filter(
                            (a) => a.groupId === group.id && a.slotIndex === slotIndex,
                          ),
                          { slotIndex, groupId: group.id },
                          (a) => eventNameOf(a.eventId),
                        ),
                      )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {picker && session && (
        <AssignmentPicker
          target={picker}
          session={session}
          events={events}
          groups={groups}
          coaches={coaches}
          onAdd={add}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  )
}
