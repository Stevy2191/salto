import { useState } from 'react'
import type { FormEvent } from 'react'
import type { GymEvent } from '../../shared/types.ts'
import { EVENT_PALETTE } from '../../shared/colors.ts'
import { apiDelete, apiGet, apiPost, apiPut } from '../lib/api.ts'
import { useLoad } from '../lib/useLoad.ts'
import { Button, Card, EmptyNote, ErrorNote, Field, FieldGroup, PageHeader, TextInput } from '../components/ui.tsx'

export interface EventFormValues {
  name: string
  /** null = no limit on simultaneous classes. */
  capacity: number | null
  active: boolean
  /** null = let the server auto-assign the next unused palette color. */
  color: string | null
}

const PALETTE_SET = new Set<string>(EVENT_PALETTE)

function ColorPicker({
  value,
  onChange,
}: {
  value: string | null
  onChange: (color: string) => void
}) {
  const selected = value?.toUpperCase() ?? null
  const isCustom = selected !== null && !PALETTE_SET.has(selected)

  return (
    <div className="flex flex-wrap items-center gap-2">
      {EVENT_PALETTE.map((color) => (
        <button
          type="button"
          key={color}
          aria-label={`color ${color}`}
          aria-pressed={selected === color}
          onClick={() => onChange(color)}
          className={`size-9 rounded-full transition-shadow ${
            selected === color
              ? 'ring-2 ring-slate-900 dark:ring-slate-100 ring-offset-2'
              : 'ring-1 ring-black/10 hover:ring-slate-400 dark:hover:ring-slate-500'
          }`}
          style={{ backgroundColor: color }}
        />
      ))}
      <label
        title="Custom color"
        className={`relative size-9 cursor-pointer overflow-hidden rounded-full ${
          isCustom ? 'ring-2 ring-slate-900 dark:ring-slate-100 ring-offset-2' : 'ring-1 ring-black/10'
        }`}
        style={
          isCustom
            ? { backgroundColor: selected }
            : { background: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' }
        }
      >
        <input
          type="color"
          value={selected ?? '#888888'}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
          aria-label="custom color"
        />
      </label>
      {value === null && <span className="text-sm text-slate-400 dark:text-slate-500">auto — next free color</span>}
    </div>
  )
}

export function EventForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: EventFormValues
  onSave: (values: EventFormValues) => Promise<void>
  onCancel?: () => void
}) {
  const [name, setName] = useState(initial.name)
  const [capacity, setCapacity] = useState(initial.capacity === null ? '' : String(initial.capacity))
  const [active, setActive] = useState(initial.active)
  const [color, setColor] = useState(initial.color)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    try {
      // Omit color entirely when unset so the server auto-assigns one.
      // A blank capacity means "no limit".
      await onSave({
        name,
        capacity: capacity.trim() === '' ? null : Number(capacity),
        active,
        color,
      })
      setName(initial.name)
      setCapacity(initial.capacity === null ? '' : String(initial.capacity))
      setActive(initial.active)
      setColor(initial.color)
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
        <Field label="Class limit (blank = no limit)">
          <TextInput
            type="number"
            min={1}
            max={20}
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            placeholder="no limit"
          />
        </Field>
        <label className="flex min-h-11 items-center gap-2 py-2 text-sm font-medium text-slate-700 dark:text-slate-200">
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
      <FieldGroup label="Color">
        <ColorPicker value={color} onChange={setColor} />
      </FieldGroup>
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
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Add event
        </h2>
        <EventForm
          initial={{ name: '', capacity: 1, active: true, color: null }}
          onSave={async ({ color, ...rest }) => {
            await apiPost('/api/events', color === null ? rest : { ...rest, color })
            await reload()
          }}
        />
      </Card>
      <Card>
        {events.length === 0 && <EmptyNote>No events yet — add your first one above.</EmptyNote>}
        <ul className="divide-y divide-slate-100 dark:divide-slate-700">
          {events.map((event) =>
            editingId === event.id ? (
              <li key={event.id} className="py-3">
                <EventForm
                  initial={event}
                  onCancel={() => setEditingId(null)}
                  onSave={async ({ color, ...rest }) => {
                    await apiPut(
                      `/api/events/${event.id}`,
                      color === null ? rest : { ...rest, color },
                    )
                    setEditingId(null)
                    await reload()
                  }}
                />
              </li>
            ) : (
              <li key={event.id} className="flex flex-wrap items-center gap-2 py-3">
                <div className="flex-1">
                  <span
                    className="mr-2 inline-block size-3.5 rounded-full align-middle ring-1 ring-black/10"
                    style={{ backgroundColor: event.color }}
                    aria-label={`color ${event.color}`}
                  />
                  <span className="font-medium text-slate-900 dark:text-slate-100">{event.name}</span>
                  {event.isSample && (
                    <span className="ml-2 rounded bg-amber-100 dark:bg-amber-900 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-200">
                      sample
                    </span>
                  )}
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {event.capacity === null
                      ? 'no class limit'
                      : event.capacity === 1
                        ? '1 class at a time'
                        : `${event.capacity} classes at a time`}
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
