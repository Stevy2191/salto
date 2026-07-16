import { useState } from 'react'
import type { FormEvent } from 'react'
import type { GymClass, Program } from '../../shared/types.ts'
import { apiDelete, apiGet, apiPost, apiPut } from '../lib/api.ts'
import { useLoad } from '../lib/useLoad.ts'
import {
  Button,
  Card,
  EmptyNote,
  ErrorNote,
  Field,
  PageHeader,
  TextInput,
} from '../components/ui.tsx'

export interface ProgramFormValues {
  name: string
  defaultStartTime: string
  defaultEndTime: string
}

export function ProgramForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: ProgramFormValues
  onSave: (values: ProgramFormValues) => Promise<void>
  onCancel?: () => void
}) {
  const [values, setValues] = useState(initial)
  const [error, setError] = useState<string | null>(null)

  const set = <K extends keyof ProgramFormValues>(key: K, value: ProgramFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    if ((values.defaultStartTime === '') !== (values.defaultEndTime === '')) {
      setError('Give both a default start and end time, or neither.')
      return
    }
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
      <div className="grid gap-3 sm:grid-cols-[1fr_9rem_9rem_auto] sm:items-end">
        <Field label="Program name">
          <TextInput
            value={values.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="e.g. Preschool, Rec Gym, Team"
            required
          />
        </Field>
        <Field label="Classes start">
          <TextInput
            type="time"
            step={300}
            value={values.defaultStartTime}
            onChange={(e) => set('defaultStartTime', e.target.value)}
            aria-label="default start time"
          />
        </Field>
        <Field label="Classes end">
          <TextInput
            type="time"
            step={300}
            value={values.defaultEndTime}
            onChange={(e) => set('defaultEndTime', e.target.value)}
            aria-label="default end time"
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
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        The clock this program's classes run on. Leave blank to use the whole session window. A
        class can override it.
      </p>
    </form>
  )
}

export function ProgramsPage() {
  const programsLoad = useLoad(() => apiGet<{ programs: Program[] }>('/api/programs'))
  const classesLoad = useLoad(() => apiGet<{ classes: GymClass[] }>('/api/classes'))
  const [editingId, setEditingId] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const programs = programsLoad.data?.programs ?? []
  const classes = classesLoad.data?.classes ?? []

  async function remove(program: Program) {
    if (!confirm(`Delete "${program.name}"?`)) return
    try {
      await apiDelete(`/api/programs/${program.id}`)
      setActionError(null)
      await programsLoad.reload()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'delete failed')
    }
  }

  const describe = (program: Program) => {
    const count = classes.filter((c) => c.programId === program.id).length
    const window =
      program.defaultStartTime && program.defaultEndTime
        ? `${program.defaultStartTime}–${program.defaultEndTime}`
        : 'runs the whole session'
    return `${count} class${count === 1 ? '' : 'es'} · ${window}`
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Programs" />
      <p className="text-sm text-slate-600 dark:text-slate-300">
        A program is an offering your gym runs — Preschool, Rec Gym, Team. Classes belong to one,
        and a session can take on a whole program at once.
      </p>
      <ErrorNote message={programsLoad.error ?? classesLoad.error ?? actionError} />
      <Card>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Add program
        </h2>
        <ProgramForm
          initial={{ name: '', defaultStartTime: '', defaultEndTime: '' }}
          onSave={async (values) => {
            await apiPost('/api/programs', {
              name: values.name,
              defaultStartTime: values.defaultStartTime || null,
              defaultEndTime: values.defaultEndTime || null,
            })
            await programsLoad.reload()
          }}
        />
      </Card>
      <Card>
        {programs.length === 0 && <EmptyNote>No programs yet — add your first one above.</EmptyNote>}
        <ul className="divide-y divide-slate-100 dark:divide-slate-700">
          {programs.map((program) =>
            editingId === program.id ? (
              <li key={program.id} className="py-3">
                <ProgramForm
                  initial={{
                    name: program.name,
                    defaultStartTime: program.defaultStartTime ?? '',
                    defaultEndTime: program.defaultEndTime ?? '',
                  }}
                  onCancel={() => setEditingId(null)}
                  onSave={async (values) => {
                    await apiPut(`/api/programs/${program.id}`, {
                      name: values.name,
                      defaultStartTime: values.defaultStartTime || null,
                      defaultEndTime: values.defaultEndTime || null,
                    })
                    setEditingId(null)
                    await programsLoad.reload()
                  }}
                />
              </li>
            ) : (
              <li key={program.id} className="flex flex-wrap items-center gap-2 py-3">
                <div className="flex-1">
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {program.name}
                  </span>
                  {program.isSample && (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900 dark:text-amber-200">
                      sample
                    </span>
                  )}
                  <p className="text-sm text-slate-500 dark:text-slate-400">{describe(program)}</p>
                </div>
                <Button variant="secondary" onClick={() => setEditingId(program.id)}>
                  Edit
                </Button>
                <Button variant="danger" onClick={() => void remove(program)}>
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
