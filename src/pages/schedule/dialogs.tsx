import { useState } from 'react'
import type { GymClass, Placement, Session } from '../../../shared/types.ts'
import {
  formatRange,
  formatTime,
  isSnapped,
  parseTime,
  sessionWindow,
} from '../../../shared/slots.ts'
import { Button, ErrorNote, Field, Select, TextInput } from '../../components/ui.tsx'

function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm space-y-3 rounded-xl bg-white p-4 shadow-lg dark:bg-slate-800"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
        {children}
      </div>
    </div>
  )
}

/** Validate a pair of HH:MM inputs against the session window. */
function validateWindow(
  session: Session,
  fromText: string,
  toText: string,
): { from: number; to: number } | string {
  const from = parseTime(fromText)
  const to = parseTime(toText)
  if (from === null || to === null) return 'Give a start and end time.'
  if (!isSnapped(from) || !isSnapped(to)) return 'Times must land on 5-minute boundaries.'
  if (to <= from) return 'The class must end after it starts.'
  const { startMin, endMin } = sessionWindow(session)
  if (from < startMin || to > endMin) {
    return `The class has to sit inside the session (${formatRange(startMin, endMin)}).`
  }
  return { from, to }
}

export function AddClassDialog({
  session,
  classes,
  columnIndex,
  onClose,
  onAdd,
}: {
  session: Session
  classes: GymClass[]
  columnIndex: number
  onClose: () => void
  /** Returns false when the lane is busy, so the dialog can say so. */
  onAdd: (classId: number, from: number, to: number) => boolean
}) {
  const { startMin, endMin } = sessionWindow(session)
  const [classId, setClassId] = useState<number | ''>(classes[0]?.id ?? '')
  const [from, setFrom] = useState(formatTime(startMin))
  const [to, setTo] = useState(formatTime(endMin))
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    if (classId === '') return
    const window = validateWindow(session, from, to)
    if (typeof window === 'string') {
      setError(window)
      return
    }
    if (!onAdd(classId, window.from, window.to)) {
      setError('That column already has a class then — a column holds one class at a time.')
    }
  }

  return (
    <Modal title={`Add a class to column ${columnIndex + 1}`} onClose={onClose}>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        A column is a lane, not a class: give the class its own window and stack another after it
        if you like.
      </p>
      <ErrorNote message={error} />
      {classes.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">Create a class first.</p>
      ) : (
        <>
          <Field label="Class">
            <Select value={classId} onChange={(e) => setClassId(Number(e.target.value))}>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Starts">
              <TextInput
                type="time"
                step={300}
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                aria-label="class starts"
              />
            </Field>
            <Field label="Ends">
              <TextInput
                type="time"
                step={300}
                value={to}
                onChange={(e) => setTo(e.target.value)}
                aria-label="class ends"
              />
            </Field>
          </div>
          <div className="flex gap-2">
            <Button onClick={submit}>Add class</Button>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </Modal>
  )
}

export function PlacementDialog({
  session,
  placement,
  className,
  columnCount,
  onClose,
  onRemove,
  onSave,
}: {
  session: Session
  placement: Placement
  className: string
  columnCount: number
  onClose: () => void
  onRemove: () => void
  /** Returns an error message, or null on success. */
  onSave: (from: number, to: number, columnIndex: number) => string | null
}) {
  const [from, setFrom] = useState(formatTime(placement.startMin))
  const [to, setTo] = useState(formatTime(placement.endMin))
  const [columnIndex, setColumnIndex] = useState(placement.columnIndex)
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    const window = validateWindow(session, from, to)
    if (typeof window === 'string') {
      setError(window)
      return
    }
    setError(onSave(window.from, window.to, columnIndex))
  }

  return (
    <Modal title={className} onClose={onClose}>
      <ErrorNote message={error} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Starts">
          <TextInput
            type="time"
            step={300}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            aria-label="class starts"
          />
        </Field>
        <Field label="Ends">
          <TextInput
            type="time"
            step={300}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            aria-label="class ends"
          />
        </Field>
      </div>
      <Field label="Column">
        <Select value={columnIndex} onChange={(e) => setColumnIndex(Number(e.target.value))}>
          {Array.from({ length: columnCount }, (_, i) => (
            <option key={i} value={i}>
              Column {i + 1}
            </option>
          ))}
        </Select>
      </Field>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Shrinking the window trims painted events that no longer fit.
      </p>
      <div className="flex gap-2">
        <Button onClick={submit}>Save</Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" className="ml-auto" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </Modal>
  )
}
