import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { GymClass, Session } from '../../shared/types.ts'
import { slotCount } from '../../shared/slots.ts'
import { formatDateLong, todayIsoDate } from '../../shared/dates.ts'
import { apiDelete, apiGet, apiPost, apiPut } from '../lib/api.ts'
import { useLoad } from '../lib/useLoad.ts'
import { sessionLabel } from '../lib/sessions.ts'
import { CopySessionDialog } from '../components/CopySessionDialog.tsx'
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

export interface SessionFormValues {
  name: string
  /** "YYYY-MM-DD" — the specific day this practice happens. */
  date: string
  startTime: string
  endTime: string
  rotationLength: number
  classes: number[]
}

export function SessionForm({
  initial,
  classes,
  onSave,
  onCancel,
}: {
  initial: SessionFormValues
  classes: GymClass[]
  onSave: (values: SessionFormValues) => Promise<void>
  onCancel?: () => void
}) {
  const [values, setValues] = useState(initial)
  const [error, setError] = useState<string | null>(null)

  function set<K extends keyof SessionFormValues>(key: K, value: SessionFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }))
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    try {
      await onSave(values)
      setValues(initial)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed')
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <ErrorNote message={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Session name (optional)">
          <TextInput
            value={values.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="e.g. Monday Team Practice"
          />
        </Field>
        <Field label="Date" hint={values.date ? formatDateLong(values.date) : undefined}>
          <TextInput
            type="date"
            value={values.date}
            onChange={(e) => set('date', e.target.value)}
            required
          />
        </Field>
        <Field label="Starts">
          <TextInput
            type="time"
            value={values.startTime}
            onChange={(e) => set('startTime', e.target.value)}
            required
          />
        </Field>
        <Field label="Ends">
          <TextInput
            type="time"
            value={values.endTime}
            onChange={(e) => set('endTime', e.target.value)}
            required
          />
        </Field>
        <Field label="Rotation length (minutes, steps of 5)">
          <TextInput
            type="number"
            min={5}
            max={240}
            step={5}
            value={values.rotationLength}
            onChange={(e) => set('rotationLength', Number(e.target.value))}
            required
          />
        </Field>
      </div>
      <FieldGroup label="Classes attending">
        <ChipPicker
          options={classes.map((c) => ({ id: c.id, label: c.name }))}
          selected={values.classes}
          onChange={(ids) => set('classes', ids)}
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

export function SessionsPage() {
  const navigate = useNavigate()
  const sessionsLoad = useLoad(() => apiGet<{ sessions: Session[] }>('/api/sessions'))
  const classesLoad = useLoad(() => apiGet<{ classes: GymClass[] }>('/api/classes'))
  const [editingId, setEditingId] = useState<number | null>(null)
  const [copying, setCopying] = useState<Session | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const sessions = sessionsLoad.data?.sessions ?? []
  const classes = classesLoad.data?.classes ?? []

  async function remove(session: Session) {
    if (!confirm(`Delete "${sessionLabel(session)}" and its schedule?`)) return
    try {
      await apiDelete(`/api/sessions/${session.id}`)
      setActionError(null)
      await sessionsLoad.reload()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'delete failed')
    }
  }

  const emptyForm: SessionFormValues = {
    name: '',
    date: todayIsoDate(),
    startTime: '16:00',
    endTime: '18:00',
    rotationLength: 15,
    classes: [],
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Sessions" />
      <ErrorNote message={sessionsLoad.error ?? classesLoad.error ?? actionError} />
      <Card>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Add session
        </h2>
        <SessionForm
          initial={emptyForm}
          classes={classes}
          onSave={async (values) => {
            await apiPost('/api/sessions', values)
            await sessionsLoad.reload()
          }}
        />
      </Card>
      <Card>
        {sessions.length === 0 && <EmptyNote>No sessions yet.</EmptyNote>}
        <ul className="divide-y divide-slate-100 dark:divide-slate-700">
          {sessions.map((session) =>
            editingId === session.id ? (
              <li key={session.id} className="py-3">
                <SessionForm
                  initial={session}
                  classes={classes}
                  onCancel={() => setEditingId(null)}
                  onSave={async (values) => {
                    await apiPut(`/api/sessions/${session.id}`, values)
                    setEditingId(null)
                    await sessionsLoad.reload()
                  }}
                />
              </li>
            ) : (
              <li key={session.id} className="flex flex-wrap items-center gap-2 py-3">
                <div className="flex-1">
                  <span className="font-medium text-slate-900 dark:text-slate-100">{sessionLabel(session)}</span>
                  {session.isSample && (
                    <span className="ml-2 rounded bg-amber-100 dark:bg-amber-900 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-200">
                      sample
                    </span>
                  )}
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {formatDateLong(session.date)} · {session.startTime}–{session.endTime} ·{' '}
                    {slotCount(session)} rotations of {session.rotationLength} min ·{' '}
                    {session.classes.length} class{session.classes.length === 1 ? '' : 'es'}
                  </p>
                </div>
                <Link
                  to={`/sessions/${session.id}/schedule`}
                  className="min-h-11 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500"
                >
                  Schedule
                </Link>
                <Button variant="secondary" onClick={() => setCopying(session)}>
                  Copy
                </Button>
                <Button variant="secondary" onClick={() => setEditingId(session.id)}>
                  Edit
                </Button>
                <Button variant="danger" onClick={() => void remove(session)}>
                  Delete
                </Button>
              </li>
            ),
          )}
        </ul>
      </Card>
      {copying && (
        <CopySessionDialog
          session={copying}
          onClose={() => setCopying(null)}
          onCopied={(newId) => navigate(`/sessions/${newId}/schedule`)}
        />
      )}
    </div>
  )
}
