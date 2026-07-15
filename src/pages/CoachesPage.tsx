import { useState } from 'react'
import type { FormEvent } from 'react'
import type { Coach, GymEvent } from '../../shared/types.ts'
import { DAY_NAMES } from '../../shared/dates.ts'
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
  TextInput,
} from '../components/ui.tsx'

export interface CoachFormValues {
  name: string
  specialties: number[]
  availability: number[]
}

export function CoachForm({
  initial,
  events,
  onSave,
  onCancel,
}: {
  initial: CoachFormValues
  events: GymEvent[]
  onSave: (values: CoachFormValues) => Promise<void>
  onCancel?: () => void
}) {
  const [name, setName] = useState(initial.name)
  const [specialties, setSpecialties] = useState(initial.specialties)
  const [availability, setAvailability] = useState(initial.availability)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    try {
      await onSave({ name, specialties, availability })
      setName(initial.name)
      setSpecialties(initial.specialties)
      setAvailability(initial.availability)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed')
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <ErrorNote message={error} />
      <Field label="Coach name">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} required />
      </Field>
      <FieldGroup label="Specialties (events they can coach)">
        <ChipPicker
          options={events.map((e) => ({ id: e.id, label: e.name }))}
          selected={specialties}
          onChange={setSpecialties}
        />
      </FieldGroup>
      <FieldGroup label="Works on">
        <ChipPicker
          options={DAY_NAMES.map((day, i) => ({ id: i, label: day.slice(0, 3) }))}
          selected={availability}
          onChange={setAvailability}
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

export function CoachesPage() {
  const coachesLoad = useLoad(() => apiGet<{ coaches: Coach[] }>('/api/coaches'))
  const eventsLoad = useLoad(() => apiGet<{ events: GymEvent[] }>('/api/events'))
  const [editingId, setEditingId] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const coaches = coachesLoad.data?.coaches ?? []
  const events = eventsLoad.data?.events ?? []
  const eventName = (id: number) => events.find((e) => e.id === id)?.name

  async function remove(coach: Coach) {
    if (!confirm(`Delete "${coach.name}"?`)) return
    try {
      await apiDelete(`/api/coaches/${coach.id}`)
      setActionError(null)
      await coachesLoad.reload()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'delete failed')
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Coaches" />
      <ErrorNote message={coachesLoad.error ?? eventsLoad.error ?? actionError} />
      <Card>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Add coach
        </h2>
        <CoachForm
          initial={{ name: '', specialties: [], availability: [] }}
          events={events}
          onSave={async (values) => {
            await apiPost('/api/coaches', values)
            await coachesLoad.reload()
          }}
        />
      </Card>
      <Card>
        {coaches.length === 0 && <EmptyNote>No coaches yet.</EmptyNote>}
        <ul className="divide-y divide-slate-100">
          {coaches.map((coach) =>
            editingId === coach.id ? (
              <li key={coach.id} className="py-3">
                <CoachForm
                  initial={coach}
                  events={events}
                  onCancel={() => setEditingId(null)}
                  onSave={async (values) => {
                    await apiPut(`/api/coaches/${coach.id}`, values)
                    setEditingId(null)
                    await coachesLoad.reload()
                  }}
                />
              </li>
            ) : (
              <li key={coach.id} className="flex flex-wrap items-center gap-2 py-3">
                <div className="flex-1">
                  <span className="font-medium text-slate-900">{coach.name}</span>
                  {coach.isSample && (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700">
                      sample
                    </span>
                  )}
                  <p className="text-sm text-slate-500">
                    {coach.specialties.length > 0
                      ? coach.specialties.map(eventName).filter(Boolean).join(', ')
                      : 'no specialties set'}
                    {' · '}
                    {coach.availability.length > 0
                      ? coach.availability.map((d) => DAY_NAMES[d]!.slice(0, 3)).join(', ')
                      : 'no days set'}
                  </p>
                </div>
                <Button variant="secondary" onClick={() => setEditingId(coach.id)}>
                  Edit
                </Button>
                <Button variant="danger" onClick={() => void remove(coach)}>
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
