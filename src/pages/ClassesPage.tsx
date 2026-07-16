import { useState } from 'react'
import type { FormEvent } from 'react'
import type {
  ClassWindow,
  Coach,
  EventPosition,
  GymClass,
  GymEvent,
  Program,
  RequiredEvent,
} from '../../shared/types.ts'
import { EVENT_POSITIONS } from '../../shared/types.ts'
import { SLOT_MINUTES, formatRange, parseTime } from '../../shared/slots.ts'
import { apiDelete, apiGet, apiPost, apiPut } from '../lib/api.ts'
import { useLoad } from '../lib/useLoad.ts'
import {
  Button,
  Card,
  ChipPicker,
  EmptyNote,
  ErrorNote,
  Field,
  FieldGroup,
  PageHeader,
  Select,
  TextInput,
} from '../components/ui.tsx'

export interface ClassFormValues {
  name: string
  programId: number | null
  priority: number
  requiredEvents: RequiredEvent[]
  defaultStartTime: string
  defaultEndTime: string
  assignedCoaches: number[]
}

const POSITION_LABELS: Record<EventPosition, string> = {
  FIRST: 'First',
  ANY: 'Anywhere',
  LAST: 'Last',
}

/** Editor draft: durations stay strings so typing is never fought. */
interface RequiredEventDraft {
  eventId: number
  duration: string
  position: EventPosition
}

const toDrafts = (entries: RequiredEvent[]): RequiredEventDraft[] =>
  entries.map((r) => ({ eventId: r.eventId, duration: String(r.duration), position: r.position }))

function RequiredEventsEditor({
  value,
  events,
  onChange,
}: {
  value: RequiredEventDraft[]
  events: GymEvent[]
  onChange: (entries: RequiredEventDraft[]) => void
}) {
  const available = events.filter((e) => !value.some((r) => r.eventId === e.id))

  return (
    <div className="space-y-2">
      {value.map((entry, index) => {
        const replace = (patch: Partial<RequiredEventDraft>) => {
          const next = [...value]
          next[index] = { ...entry, ...patch }
          onChange(next)
        }
        return (
          <div key={entry.eventId} className="flex flex-wrap items-center gap-2">
            <Select
              className="max-w-48"
              value={entry.eventId}
              onChange={(e) => replace({ eventId: Number(e.target.value) })}
              aria-label="event"
            >
              {[events.find((ev) => ev.id === entry.eventId), ...available]
                .filter((ev): ev is GymEvent => ev !== undefined)
                .map((ev) => (
                  <option key={ev.id} value={ev.id}>
                    {ev.name}
                  </option>
                ))}
            </Select>
            <TextInput
              type="number"
              className="max-w-20"
              min={5}
              step={5}
              value={entry.duration}
              onChange={(e) => replace({ duration: e.target.value })}
              aria-label="duration in minutes"
            />
            <span className="text-sm text-slate-500 dark:text-slate-400">min</span>
            <Select
              className="max-w-32"
              value={entry.position}
              onChange={(e) => replace({ position: e.target.value as EventPosition })}
              aria-label="position"
            >
              {EVENT_POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {POSITION_LABELS[p]}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              variant="danger"
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          </div>
        )
      })}
      {available.length > 0 && (
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            onChange([...value, { eventId: available[0]!.id, duration: '30', position: 'ANY' }])
          }
        >
          + Add event
        </Button>
      )}
      {events.length === 0 && (
        <p className="text-sm text-slate-400 dark:text-slate-500">
          Create events first, then set what this class does.
        </p>
      )}
      {value.length > 0 && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          "First" is a warm-up, "Last" a cool-down — they fix the order, not the clock, so a class
          still waits its turn for a busy apparatus.
        </p>
      )}
    </div>
  )
}

/**
 * Live feedback while editing: total time asked for against the window the
 * class will actually run on. This is the last chance to see that a class
 * cannot fit before hitting Generate, so it has to be honest about which
 * window it is measuring against.
 */
function FitSummary({
  drafts,
  windows,
  classId,
  ownWindow,
  programWindow,
}: {
  drafts: RequiredEventDraft[]
  windows: ClassWindow[]
  classId: number | null
  ownWindow: { start: string; end: string }
  programWindow: { start: string | null; end: string | null } | null
}) {
  if (drafts.length === 0) return null
  const total = drafts.reduce((sum, d) => sum + (Number(d.duration) || 0), 0)
  const offAxis = drafts.filter(
    (d) => Number(d.duration) > 0 && Number(d.duration) % SLOT_MINUTES !== 0,
  )

  // The clock this class will run on: its own, else its program's.
  const start = ownWindow.start || programWindow?.start || null
  const end = ownWindow.end || programWindow?.end || null
  const source = ownWindow.start ? 'its own times' : programWindow?.start ? "its program's times" : null
  const defaultMinutes =
    start && end ? (parseTime(end) ?? 0) - (parseTime(start) ?? 0) : null

  return (
    <div className="mt-2 space-y-1 rounded-lg bg-slate-50 p-2 text-sm dark:bg-slate-700">
      <p className="font-medium text-slate-700 dark:text-slate-200">Total required: {total} min</p>
      {offAxis.length > 0 && (
        <p className="font-medium text-red-600 dark:text-red-400">
          ⚠ {offAxis.map((d) => `${d.duration} min`).join(', ')} — durations must be a multiple of{' '}
          {SLOT_MINUTES} minutes
        </p>
      )}
      {defaultMinutes !== null && (
        <p
          className={
            defaultMinutes < total
              ? 'font-medium text-red-600 dark:text-red-400'
              : 'text-emerald-700 dark:text-emerald-300'
          }
        >
          Window {start}–{end} ({source}, {defaultMinutes} min):{' '}
          {defaultMinutes < total
            ? `⚠ over by ${total - defaultMinutes} min`
            : `fits with ${defaultMinutes - total} min spare`}
        </p>
      )}
      {defaultMinutes === null && (
        <p className="text-slate-500 dark:text-slate-400">
          No window set here or on its program — it will run the whole session.
        </p>
      )}
      {classId !== null &&
        windows.map((w) => {
          const available = w.endMin - w.startMin
          const spare = available - total
          return (
            <p
              key={`${w.sessionId}:${w.startMin}`}
              className={
                spare < 0
                  ? 'font-medium text-red-600 dark:text-red-400'
                  : 'text-emerald-700 dark:text-emerald-300'
              }
            >
              {w.sessionName || w.date} {formatRange(w.startMin, w.endMin)} ({available} min):{' '}
              {spare < 0 ? `⚠ over by ${-spare} min` : `fits with ${spare} min spare`}
            </p>
          )
        })}
    </div>
  )
}

export function ClassForm({
  initial,
  classId = null,
  events,
  coaches,
  programs,
  windows = [],
  onSave,
  onCancel,
}: {
  initial: ClassFormValues
  /** Id of the class being edited, for checking fit against its sessions. */
  classId?: number | null
  events: GymEvent[]
  coaches: Coach[]
  programs: Program[]
  /** Where this class is already placed, for the fit summary. */
  windows?: ClassWindow[]
  onSave: (values: ClassFormValues) => Promise<void>
  onCancel?: () => void
}) {
  const [name, setName] = useState(initial.name)
  // Not defaulted into state: programs are still loading on first render,
  // so freezing programs[0] here would leave the select permanently unset.
  const [programId, setProgramId] = useState<number | ''>(initial.programId ?? '')
  const [priority, setPriority] = useState(String(initial.priority))
  const [requiredEvents, setRequiredEvents] = useState(toDrafts(initial.requiredEvents))
  const [start, setStart] = useState(initial.defaultStartTime)
  const [end, setEnd] = useState(initial.defaultEndTime)
  const [assignedCoaches, setAssignedCoaches] = useState(initial.assignedCoaches)
  const [error, setError] = useState<string | null>(null)

  const chosenProgramId: number | '' = programId === '' ? (programs[0]?.id ?? '') : programId
  const program = programs.find((p) => p.id === chosenProgramId) ?? null

  async function submit(e: FormEvent) {
    e.preventDefault()
    if ((start === '') !== (end === '')) {
      setError('Give both a start and end time, or neither.')
      return
    }
    const parsed: RequiredEvent[] = []
    for (const draft of requiredEvents) {
      const duration = Number(draft.duration)
      const eventName = events.find((ev) => ev.id === draft.eventId)?.name ?? 'an event'
      if (!Number.isInteger(duration) || duration < 5 || duration % 5 !== 0) {
        setError(`Give ${eventName} a duration in minutes (a multiple of 5).`)
        return
      }
      parsed.push({ eventId: draft.eventId, duration, position: draft.position })
    }
    try {
      await onSave({
        name,
        programId: chosenProgramId === '' ? null : chosenProgramId,
        priority: Number(priority),
        requiredEvents: parsed,
        defaultStartTime: start,
        defaultEndTime: end,
        assignedCoaches,
      })
      setName(initial.name)
      setPriority(String(initial.priority))
      setRequiredEvents(toDrafts(initial.requiredEvents))
      setStart(initial.defaultStartTime)
      setEnd(initial.defaultEndTime)
      setAssignedCoaches(initial.assignedCoaches)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed')
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <ErrorNote message={error} />
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem_7rem]">
        <Field label="Class name">
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Tiny Tot 1"
            required
          />
        </Field>
        <Field label="Program">
          <Select
            value={chosenProgramId}
            onChange={(e) => setProgramId(e.target.value === '' ? '' : Number(e.target.value))}
            aria-label="program"
          >
            {programs.length === 0 && <option value="">No programs yet</option>}
            {programs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Priority">
          <TextInput
            type="number"
            min={0}
            max={100}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            required
          />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-[10rem_10rem_1fr] sm:items-end">
        <Field label="Starts (optional)">
          <TextInput
            type="time"
            step={300}
            value={start}
            onChange={(e) => setStart(e.target.value)}
            aria-label="class start time"
          />
        </Field>
        <Field label="Ends (optional)">
          <TextInput
            type="time"
            step={300}
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            aria-label="class end time"
          />
        </Field>
        <p className="pb-2 text-xs text-slate-500 dark:text-slate-400">
          {program?.defaultStartTime
            ? `Blank uses ${program.name}'s ${program.defaultStartTime}–${program.defaultEndTime}.`
            : 'Blank uses the whole session window.'}
        </p>
      </div>
      <FieldGroup label="What this class does, and for how long">
        <RequiredEventsEditor value={requiredEvents} events={events} onChange={setRequiredEvents} />
        <FitSummary
          drafts={requiredEvents}
          windows={windows}
          classId={classId}
          ownWindow={{ start, end }}
          programWindow={
            program ? { start: program.defaultStartTime, end: program.defaultEndTime } : null
          }
        />
      </FieldGroup>
      <FieldGroup label="Assigned coaches">
        <ChipPicker
          options={coaches.map((c) => ({ id: c.id, label: c.name }))}
          selected={assignedCoaches}
          onChange={setAssignedCoaches}
        />
      </FieldGroup>
      <div className="flex gap-2">
        <Button type="submit">Save</Button>
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}

export function ClassesPage() {
  const classesLoad = useLoad(() => apiGet<{ classes: GymClass[] }>('/api/classes'))
  const eventsLoad = useLoad(() => apiGet<{ events: GymEvent[] }>('/api/events'))
  const coachesLoad = useLoad(() => apiGet<{ coaches: Coach[] }>('/api/coaches'))
  const programsLoad = useLoad(() => apiGet<{ programs: Program[] }>('/api/programs'))
  const [editingId, setEditingId] = useState<number | null>(null)
  const [windows, setWindows] = useState<ClassWindow[]>([])
  const [actionError, setActionError] = useState<string | null>(null)

  const classes = classesLoad.data?.classes ?? []
  const events = eventsLoad.data?.events ?? []
  const coaches = coachesLoad.data?.coaches ?? []
  const programs = programsLoad.data?.programs ?? []

  async function remove(cls: GymClass) {
    if (!confirm(`Delete "${cls.name}"? Its schedule cells will be removed.`)) return
    try {
      await apiDelete(`/api/classes/${cls.id}`)
      setActionError(null)
      await classesLoad.reload()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'delete failed')
    }
  }

  function describe(cls: GymClass): string {
    const total = cls.requiredEvents.reduce((sum, r) => sum + r.duration, 0)
    const names = cls.requiredEvents
      .map((r) => {
        const name = events.find((e) => e.id === r.eventId)?.name
        if (!name) return undefined
        const mark = r.position === 'FIRST' ? ' (first)' : r.position === 'LAST' ? ' (last)' : ''
        return `${name} ${r.duration}′${mark}`
      })
      .filter(Boolean)
    const coachNames = cls.assignedCoaches
      .map((id) => coaches.find((c) => c.id === id)?.name)
      .filter(Boolean)
    return [
      names.length > 0 ? `${names.join(', ')} (${total} min total)` : 'no events set',
      cls.defaultStartTime ? `${cls.defaultStartTime}–${cls.defaultEndTime}` : null,
      coachNames.length > 0 ? `coached by ${coachNames.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join(' · ')
  }

  const startEditing = (cls: GymClass) => {
    setEditingId(cls.id)
    setWindows([])
    void apiGet<{ windows: ClassWindow[] }>(`/api/classes/${cls.id}/windows`)
      .then((r) => setWindows(r.windows))
      .catch(() => setWindows([]))
  }

  const emptyForm: ClassFormValues = {
    name: '',
    programId: null,
    priority: 0,
    requiredEvents: [],
    defaultStartTime: '',
    defaultEndTime: '',
    assignedCoaches: [],
  }

  const save = (values: ClassFormValues) => ({
    ...values,
    defaultStartTime: values.defaultStartTime || null,
    defaultEndTime: values.defaultEndTime || null,
  })

  // Grouped by program, with anything unassigned last — a class with no
  // program cannot be generated from, so it should be visible, not hidden.
  const groups: { program: Program | null; items: GymClass[] }[] = [
    ...programs.map((program) => ({
      program,
      items: classes.filter((c) => c.programId === program.id),
    })),
    { program: null, items: classes.filter((c) => c.programId === null) },
  ].filter((g) => g.items.length > 0 || g.program !== null)

  return (
    <div className="space-y-4">
      <PageHeader title="Classes" />
      <ErrorNote
        message={
          classesLoad.error ??
          eventsLoad.error ??
          coachesLoad.error ??
          programsLoad.error ??
          actionError
        }
      />
      {programs.length === 0 && (
        <Card>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Classes belong to a program. Add one on the{' '}
            <a className="font-medium text-indigo-600 dark:text-indigo-400" href="/programs">
              Programs
            </a>{' '}
            page first.
          </p>
        </Card>
      )}
      <Card>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Add class
        </h2>
        <ClassForm
          initial={emptyForm}
          events={events}
          coaches={coaches}
          programs={programs}
          onSave={async (values) => {
            await apiPost('/api/classes', save(values))
            await classesLoad.reload()
          }}
        />
      </Card>

      {classes.length === 0 && (
        <Card>
          <EmptyNote>No classes yet.</EmptyNote>
        </Card>
      )}
      {groups.map(({ program, items }) => (
        <Card key={program?.id ?? 'none'}>
          <h2 className="mb-1 text-sm font-bold text-slate-900 dark:text-slate-100">
            {program?.name ?? 'No program'}
            <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
              {program?.defaultStartTime
                ? `${program.defaultStartTime}–${program.defaultEndTime}`
                : program
                  ? 'whole session'
                  : 'assign these to a program so they can be generated'}
            </span>
          </h2>
          {items.length === 0 && <EmptyNote>No classes in this program yet.</EmptyNote>}
          <ul className="divide-y divide-slate-100 dark:divide-slate-700">
            {items.map((cls) =>
              editingId === cls.id ? (
                <li key={cls.id} className="py-3">
                  <ClassForm
                    initial={{
                      ...cls,
                      defaultStartTime: cls.defaultStartTime ?? '',
                      defaultEndTime: cls.defaultEndTime ?? '',
                    }}
                    classId={cls.id}
                    events={events}
                    coaches={coaches}
                    programs={programs}
                    windows={windows}
                    onCancel={() => setEditingId(null)}
                    onSave={async (values) => {
                      await apiPut(`/api/classes/${cls.id}`, save(values))
                      setEditingId(null)
                      await classesLoad.reload()
                    }}
                  />
                </li>
              ) : (
                <li key={cls.id} className="flex flex-wrap items-center gap-2 py-3">
                  <div className="flex-1">
                    <span className="font-medium text-slate-900 dark:text-slate-100">
                      {cls.name}
                    </span>
                    <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                      priority {cls.priority}
                    </span>
                    {cls.isSample && (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900 dark:text-amber-200">
                        sample
                      </span>
                    )}
                    <p className="text-sm text-slate-500 dark:text-slate-400">{describe(cls)}</p>
                  </div>
                  <Button variant="secondary" onClick={() => startEditing(cls)}>
                    Edit
                  </Button>
                  <Button variant="danger" onClick={() => void remove(cls)}>
                    Delete
                  </Button>
                </li>
              ),
            )}
          </ul>
        </Card>
      ))}
    </div>
  )
}
