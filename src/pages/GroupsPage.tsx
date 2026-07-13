import { useState } from 'react'
import type { FormEvent } from 'react'
import type { Coach, Group, GymEvent, RequiredEvent } from '../../shared/types.ts'
import { apiDelete, apiGet, apiPost, apiPut } from '../lib/api.ts'
import { useLoad } from '../lib/useLoad.ts'
import {
  Button,
  Card,
  ChipPicker,
  EmptyNote,
  ErrorNote,
  Field,
  PageHeader,
  Select,
  TextInput,
} from '../components/ui.tsx'

export interface GroupFormValues {
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
        <p className="text-sm text-slate-400">Create events first, then set what this group needs.</p>
      )}
    </div>
  )
}

export function GroupForm({
  initial,
  events,
  coaches,
  onSave,
  onCancel,
}: {
  initial: GroupFormValues
  events: GymEvent[]
  coaches: Coach[]
  onSave: (values: GroupFormValues) => Promise<void>
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
        <Field label="Group name">
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
      <Field label="Required events per session">
        <RequiredEventsEditor value={requiredEvents} events={events} onChange={setRequiredEvents} />
      </Field>
      <Field label="Assigned coaches">
        <ChipPicker
          options={coaches.map((c) => ({ id: c.id, label: c.name }))}
          selected={assignedCoaches}
          onChange={setAssignedCoaches}
        />
      </Field>
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

export function GroupsPage() {
  const groupsLoad = useLoad(() => apiGet<{ groups: Group[] }>('/api/groups'))
  const eventsLoad = useLoad(() => apiGet<{ events: GymEvent[] }>('/api/events'))
  const coachesLoad = useLoad(() => apiGet<{ coaches: Coach[] }>('/api/coaches'))
  const [editingId, setEditingId] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const groups = groupsLoad.data?.groups ?? []
  const events = eventsLoad.data?.events ?? []
  const coaches = coachesLoad.data?.coaches ?? []

  async function remove(group: Group) {
    if (!confirm(`Delete "${group.name}"? Its schedule cells will be removed.`)) return
    try {
      await apiDelete(`/api/groups/${group.id}`)
      setActionError(null)
      await groupsLoad.reload()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'delete failed')
    }
  }

  function describe(group: Group): string {
    const total = group.requiredEvents.reduce((sum, r) => sum + r.duration, 0)
    const names = group.requiredEvents
      .map((r) => events.find((e) => e.id === r.eventId)?.name)
      .filter(Boolean)
    const coachNames = group.assignedCoaches
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
      <PageHeader title="Groups" />
      <ErrorNote message={groupsLoad.error ?? eventsLoad.error ?? coachesLoad.error ?? actionError} />
      <Card>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Add group
        </h2>
        <GroupForm
          initial={{ name: '', priority: 0, requiredEvents: [], assignedCoaches: [] }}
          events={events}
          coaches={coaches}
          onSave={async (values) => {
            await apiPost('/api/groups', values)
            await groupsLoad.reload()
          }}
        />
      </Card>
      <Card>
        {groups.length === 0 && <EmptyNote>No groups yet.</EmptyNote>}
        <ul className="divide-y divide-slate-100">
          {groups.map((group) =>
            editingId === group.id ? (
              <li key={group.id} className="py-3">
                <GroupForm
                  initial={group}
                  events={events}
                  coaches={coaches}
                  onCancel={() => setEditingId(null)}
                  onSave={async (values) => {
                    await apiPut(`/api/groups/${group.id}`, values)
                    setEditingId(null)
                    await groupsLoad.reload()
                  }}
                />
              </li>
            ) : (
              <li key={group.id} className="flex flex-wrap items-center gap-2 py-3">
                <div className="flex-1">
                  <span className="font-medium text-slate-900">{group.name}</span>
                  <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
                    priority {group.priority}
                  </span>
                  {group.isSample && (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700">
                      sample
                    </span>
                  )}
                  <p className="text-sm text-slate-500">{describe(group)}</p>
                </div>
                <Button variant="secondary" onClick={() => setEditingId(group.id)}>
                  Edit
                </Button>
                <Button variant="danger" onClick={() => void remove(group)}>
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
