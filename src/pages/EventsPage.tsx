import { useState } from 'react'
import type { FormEvent } from 'react'
import type { GymEvent } from '../../shared/types.ts'
import { apiDelete, apiGet, apiPost, apiPut } from '../lib/api.ts'
import { useLoad } from '../lib/useLoad.ts'
import { Button, Card, EmptyNote, ErrorNote, Field, PageHeader, TextInput } from '../components/ui.tsx'

interface EventFormValues {
  name: string
  capacity: number
  active: boolean
}

function EventForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: EventFormValues
  onSave: (values: EventFormValues) => Promise<void>
  onCancel?: () => void
}) {
  const [name, setName] = useState(initial.name)
  const [capacity, setCapacity] = useState(String(initial.capacity))
  const [active, setActive] = useState(initial.active)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    try {
      await onSave({ name, capacity: Number(capacity), active })
      setName(initial.name)
      setCapacity(String(initial.capacity))
      setActive(initial.active)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed')
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <ErrorNote message={error} />
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem_auto_auto] sm:items-end">
        <Field label="Event name">
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Beam, Tumble Track"
            required
          />
        </Field>
        <Field label="Capacity (groups at once)">
          <TextInput
            type="number"
            min={1}
            max={20}
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            required
          />
        </Field>
        <label className="flex min-h-11 items-center gap-2 py-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="size-5 accent-indigo-600"
          />
          Active
        </label>
        <div className="flex gap-2">
          <Button type="submit">Save</Button>
          {onCancel && (
            <Button type="button" variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </form>
  )
}

export function EventsPage() {
  const { data, error, reload } = useLoad(() => apiGet<{ events: GymEvent[] }>('/api/events'))
  const [editingId, setEditingId] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const events = data?.events ?? []

  async function remove(event: GymEvent) {
    if (!confirm(`Delete "${event.name}"? Any schedule cells using it will be removed.`)) return
    try {
      await apiDelete(`/api/events/${event.id}`)
      setActionError(null)
      await reload()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'delete failed')
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Events" />
      <ErrorNote message={error ?? actionError} />
      <Card>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Add event
        </h2>
        <EventForm
          initial={{ name: '', capacity: 1, active: true }}
          onSave={async (values) => {
            await apiPost('/api/events', values)
            await reload()
          }}
        />
      </Card>
      <Card>
        {events.length === 0 && <EmptyNote>No events yet — add your first one above.</EmptyNote>}
        <ul className="divide-y divide-slate-100">
          {events.map((event) =>
            editingId === event.id ? (
              <li key={event.id} className="py-3">
                <EventForm
                  initial={event}
                  onCancel={() => setEditingId(null)}
                  onSave={async (values) => {
                    await apiPut(`/api/events/${event.id}`, values)
                    setEditingId(null)
                    await reload()
                  }}
                />
              </li>
            ) : (
              <li key={event.id} className="flex flex-wrap items-center gap-2 py-3">
                <div className="flex-1">
                  <span className="font-medium text-slate-900">{event.name}</span>
                  {event.isSample && (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700">
                      sample
                    </span>
                  )}
                  <p className="text-sm text-slate-500">
                    {event.capacity === 1 ? '1 group at a time' : `${event.capacity} groups at a time`}
                    {!event.active && ' · inactive'}
                  </p>
                </div>
                <Button variant="secondary" onClick={() => setEditingId(event.id)}>
                  Edit
                </Button>
                <Button variant="danger" onClick={() => void remove(event)}>
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
