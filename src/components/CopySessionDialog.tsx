import { useState } from 'react'
import type { Session } from '../../shared/types.ts'
import { addDays, formatDateLong } from '../../shared/dates.ts'
import { apiPost } from '../lib/api.ts'
import { Button, ErrorNote, Field, TextInput } from './ui.tsx'
import { sessionLabel } from '../lib/sessions.ts'

/**
 * Copying a session onto a new date is the weekly workflow: last Monday's
 * practice becomes this Monday's. Defaults to one week out, the common case.
 */
export function CopySessionDialog({
  session,
  onClose,
  onCopied,
}: {
  session: Session
  onClose: () => void
  onCopied: (newSessionId: number) => void
}) {
  const [date, setDate] = useState(addDays(session.date, 7))
  const [name, setName] = useState(session.name)
  const [startTime, setStartTime] = useState(session.startTime)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const create = async () => {
    setBusy(true)
    try {
      const res = await apiPost<{ session: Session }>(`/api/sessions/${session.id}/copy`, {
        name,
        date,
        startTime,
      })
      onCopied(res.session.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'copy failed')
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-10 flex items-end justify-center bg-black/30 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm space-y-3 rounded-xl bg-white dark:bg-slate-800 p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-semibold text-slate-900 dark:text-slate-100">Copy "{sessionLabel(session)}"</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Same classes, rotation length, duration, and schedule — pick the date it repeats on.
          Copied assignments arrive unlocked.
        </p>
        <ErrorNote message={error} />
        <Field label="New date" hint={date ? formatDateLong(date) : undefined}>
          <TextInput
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </Field>
        <Field label="Name (optional)">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Starts">
          <TextInput
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            required
          />
        </Field>
        <div className="flex gap-2">
          <Button disabled={busy || date === ''} onClick={() => void create()}>
            Create copy
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}
