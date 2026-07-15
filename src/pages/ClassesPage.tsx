import { useState } from 'react'
import type { FormEvent } from 'react'
import type { Coach, GymClass, GymEvent, RequiredEvent } from '../../shared/types.ts'
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

function RequiredEventsEditor({
  value,
  events,
  onChange,
}: {
  value: RequiredEvent[]
  events: GymEvent[]
  onChange: (entries: RequiredEvent[]) => void
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
              next[index] = { ...entry, duration: Number(e.target.value) }
              onChange(next)
            }}
            aria-label="duration in minutes"
          />
          <span className="text-sm text-slate-500">min</span>
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
          onClick={() => onChange([...value, { eventId: available[0]!.id, duration: 30 }])}
        >
          + Add event
        </Button>
      )}
      {events.length === 0 && (
        <p className="text-sm text-slate-400">Create events first, then set what this class needs.</p>
      )}
    </div>
  )
}

export function ClassForm({
  initial,
  events,
  coaches,
  onSave,
  onCancel,
}: {
  initial: ClassFormValues
  events: GymEvent[]
  coaches: Coach[]
  onSave: (values: ClassFormValues) => Promise<void>
  onCancel?: () => void
}) {
  const [name, setName] = useState(initial.name)
  const [priority, setPriority] = useState(String(initial.priority))
  const [requiredEvents, setRequiredEvents] = useState(initial.requiredEvents)
  const [assignedCoaches, setAssignedCoaches] = useState(initial.assignedCoaches)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    try {
      await onSave({ name, priority: Number(priority), requiredEvents, assignedCoaches })
      setName(initial.name)
      setPriority(String(initial.priority))
      setRequiredEvents(initial.requiredEvents)
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
      .map((r) => events.find((e) => e.id === r.eventId)?.name)
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
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
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
        <ul className="divide-y divide-slate-100">
          {classes.map((cls) =>
            editingId === cls.id ? (
              <li key={cls.id} className="py-3">
                <ClassForm
                  initial={cls}
                  events={events}
                  coaches={coaches}
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
                  <span className="font-medium text-slate-900">{cls.name}</span>
                  <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
                    priority {cls.priority}
                  </span>
                  {cls.isSample && (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700">
                      sample
                    </span>
                  )}
                  <p className="text-sm text-slate-500">{describe(cls)}</p>
                </div>
                <Button variant="secondary" onClick={() => setEditingId(cls.id)}>
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
