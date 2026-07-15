import { useState } from 'react'
import type { FormEvent } from 'react'
import type { ClassWindow, Coach, GymClass, GymEvent, RequiredEvent } from '../../shared/types.ts'
import { SLOT_MINUTES, formatRange } from '../../shared/slots.ts'
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
  priority: number
  requiredEvents: RequiredEvent[]
  assignedCoaches: number[]
}

/** Editor draft: durations stay strings so typing is never fought. */
interface RequiredEventDraft {
  eventId: number
  duration: string
}

const toDrafts = (entries: RequiredEvent[]): RequiredEventDraft[] =>
  entries.map((r) => ({ eventId: r.eventId, duration: String(r.duration) }))

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
      {value.map((entry, index) => (
        <div key={entry.eventId} className="flex flex-wrap items-center gap-2">
          <Select
            className="max-w-52"
            value={entry.eventId}
            onChange={(e) => {
              const next = [...value]
              next[index] = { ...entry, eventId: Number(e.target.value) }
              onChange(next)
            }}
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
            className="max-w-24"
            min={5}
            step={5}
            value={entry.duration}
            onChange={(e) => {
              const next = [...value]
              next[index] = { ...entry, duration: e.target.value }
              onChange(next)
            }}
            aria-label="duration in minutes"
          />
          <span className="text-sm text-slate-500 dark:text-slate-400">min</span>
          <Button
            type="button"
            variant="danger"
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      {available.length > 0 && (
        <Button
          type="button"
          variant="secondary"
          onClick={() => onChange([...value, { eventId: available[0]!.id, duration: '30' }])}
        >
          + Add event
        </Button>
      )}
      {events.length === 0 && (
        <p className="text-sm text-slate-400 dark:text-slate-500">Create events first, then set what this class needs.</p>
      )}
    </div>
  )
}

/**
 * Live feedback while editing requirements: total time asked for, and — for
 * every window this class is placed in — whether it fits. The class's own
 * window is what matters now, not the length of the session it sits in.
 */
function FitSummary({
  drafts,
  windows,
  classId,
}: {
  drafts: RequiredEventDraft[]
  windows: ClassWindow[]
  classId: number | null
}) {
  if (drafts.length === 0) return null
  const total = drafts.reduce((sum, d) => sum + (Number(d.duration) || 0), 0)
  const offAxis = drafts.filter(
    (d) => Number(d.duration) > 0 && Number(d.duration) % SLOT_MINUTES !== 0,
  )

  return (
    <div className="mt-2 space-y-1 rounded-lg bg-slate-50 p-2 text-sm dark:bg-slate-700">
      <p className="font-medium text-slate-700 dark:text-slate-200">Total required: {total} min</p>
      {offAxis.length > 0 && (
        <p className="font-medium text-red-600 dark:text-red-400">
          ⚠ {offAxis.map((d) => `${d.duration} min`).join(', ')} — durations must be a multiple of{' '}
          {SLOT_MINUTES} minutes
        </p>
      )}
      {classId === null ? (
        <p className="text-slate-500 dark:text-slate-400">
          Save the class, then place it in a session to check the time fits.
        </p>
      ) : windows.length === 0 ? (
        <p className="text-slate-500 dark:text-slate-400">
          Not placed in any session yet — add it to a column to check the time fits.
        </p>
      ) : (
        windows.map((w) => {
          const available = w.endMin - w.startMin
          const spare = available - total
          return (
            <p
              key={`${w.sessionId}:${w.startMin}`}
              className={
                spare < 0 ? 'font-medium text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-300'
              }
            >
              {w.sessionName || w.date} {formatRange(w.startMin, w.endMin)} ({available} min):{' '}
              {spare < 0 ? `⚠ over by ${-spare} min` : `fits with ${spare} min spare`}
            </p>
          )
        })
      )}
    </div>
  )
}

export function ClassForm({
  initial,
  classId = null,
  events,
  coaches,
  windows = [],
  onSave,
  onCancel,
}: {
  initial: ClassFormValues
  /** Id of the class being edited, for checking fit against its sessions. */
  classId?: number | null
  events: GymEvent[]
  coaches: Coach[]
  /** Where this class is placed, for the fit summary. */
  windows?: ClassWindow[]
  onSave: (values: ClassFormValues) => Promise<void>
  onCancel?: () => void
}) {
  const [name, setName] = useState(initial.name)
  const [priority, setPriority] = useState(String(initial.priority))
  const [requiredEvents, setRequiredEvents] = useState(toDrafts(initial.requiredEvents))
  const [assignedCoaches, setAssignedCoaches] = useState(initial.assignedCoaches)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const parsed: RequiredEvent[] = []
    for (const draft of requiredEvents) {
      const duration = Number(draft.duration)
      const eventName = events.find((ev) => ev.id === draft.eventId)?.name ?? 'an event'
      if (!Number.isInteger(duration) || duration < 5 || duration % 5 !== 0) {
        setError(`Give ${eventName} a duration in minutes (a multiple of 5).`)
        return
      }
      parsed.push({ eventId: draft.eventId, duration })
    }
    try {
      await onSave({ name, priority: Number(priority), requiredEvents: parsed, assignedCoaches })
      setName(initial.name)
      setPriority(String(initial.priority))
      setRequiredEvents(toDrafts(initial.requiredEvents))
      setAssignedCoaches(initial.assignedCoaches)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed')
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <ErrorNote message={error} />
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
        <Field label="Class name">
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Level 3 Girls"
            required
          />
        </Field>
        <Field label="Priority (higher wins)">
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
      <FieldGroup label="Required events per session">
        <RequiredEventsEditor value={requiredEvents} events={events} onChange={setRequiredEvents} />
        <FitSummary drafts={requiredEvents} windows={windows} classId={classId} />
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
  const [editingId, setEditingId] = useState<number | null>(null)
  const [windows, setWindows] = useState<ClassWindow[]>([])
  const [actionError, setActionError] = useState<string | null>(null)

  const classes = classesLoad.data?.classes ?? []
  const events = eventsLoad.data?.events ?? []
  const coaches = coachesLoad.data?.coaches ?? []

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
        return name ? `${name} ${r.duration}′` : undefined
      })
      .filter(Boolean)
    const coachNames = cls.assignedCoaches
      .map((id) => coaches.find((c) => c.id === id)?.name)
      .filter(Boolean)
    const parts = [
      names.length > 0 ? `${names.join(', ')} (${total} min total)` : 'no required events',
      coachNames.length > 0 ? `coached by ${coachNames.join(', ')}` : null,
    ]
    return parts.filter(Boolean).join(' · ')
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Classes" />
      <ErrorNote message={classesLoad.error ?? eventsLoad.error ?? coachesLoad.error ?? actionError} />
      <Card>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Add class
        </h2>
        <ClassForm
          initial={{ name: '', priority: 0, requiredEvents: [], assignedCoaches: [] }}
          events={events}
          coaches={coaches}
          onSave={async (values) => {
            await apiPost('/api/classes', values)
            await classesLoad.reload()
          }}
        />
      </Card>
      <Card>
        {classes.length === 0 && <EmptyNote>No classes yet.</EmptyNote>}
        <ul className="divide-y divide-slate-100 dark:divide-slate-700">
          {classes.map((cls) =>
            editingId === cls.id ? (
              <li key={cls.id} className="py-3">
                <ClassForm
                  initial={cls}
                  classId={cls.id}
                  events={events}
                  coaches={coaches}
                  windows={windows}
                  onCancel={() => setEditingId(null)}
                  onSave={async (values) => {
                    await apiPut(`/api/classes/${cls.id}`, values)
                    setEditingId(null)
                    await classesLoad.reload()
                  }}
                />
              </li>
            ) : (
              <li key={cls.id} className="flex flex-wrap items-center gap-2 py-3">
                <div className="flex-1">
                  <span className="font-medium text-slate-900 dark:text-slate-100">{cls.name}</span>
                  <span className="ml-2 rounded bg-slate-100 dark:bg-slate-700 px-1.5 py-0.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                    priority {cls.priority}
                  </span>
                  {cls.isSample && (
                    <span className="ml-2 rounded bg-amber-100 dark:bg-amber-900 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-200">
                      sample
                    </span>
                  )}
                  <p className="text-sm text-slate-500 dark:text-slate-400">{describe(cls)}</p>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setEditingId(cls.id)
                    setWindows([])
                    void apiGet<{ windows: ClassWindow[] }>(`/api/classes/${cls.id}/windows`)
                      .then((r) => setWindows(r.windows))
                      .catch(() => setWindows([]))
                  }}
                >
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
    </div>
  )
}
