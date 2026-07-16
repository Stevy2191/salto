import { useState } from 'react'
import type { FormEvent } from 'react'
import type { Coach, GymClass, GymEvent, Program } from '../../shared/types.ts'
import { SLOT_MINUTES } from '../../shared/slots.ts'
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
import { SetupProgress } from '../components/SetupProgress.tsx'

export interface ClassFormValues {
  name: string
  programId: number | null
  priority: number
  /** Weekdays this class meets (0 = Sunday … 6 = Saturday). */
  daysOfWeek: number[]
  /** "HH:MM" 24h start time, or "" when not scheduled yet. */
  startTime: string
  /** The events this class may use, each with its per-class minutes. */
  eligibleEvents: GymClass['eligibleEvents']
  /** Whole period length in minutes; a multiple of SLOT_MINUTES. */
  periodMinutes: number
  /** Optional fixed opening block. Null event id means no warm-up. */
  warmupEventId: number | null
  warmupMinutes: number
  /** Optional fixed closing block. Null event id means no cool-down. */
  cooldownEventId: number | null
  cooldownMinutes: number
  assignedCoaches: number[]
}

const DAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Toggle which weekdays a class meets. */
function DayPicker({ value, onChange }: { value: number[]; onChange: (days: number[]) => void }) {
  const toggle = (day: number) =>
    onChange(value.includes(day) ? value.filter((d) => d !== day) : [...value, day].sort((a, b) => a - b))
  return (
    <div className="flex gap-1">
      {DAY_INITIALS.map((initial, day) => {
        const on = value.includes(day)
        return (
          <button
            key={day}
            type="button"
            aria-label={DAY_FULL[day]}
            aria-pressed={on}
            onClick={() => toggle(day)}
            className={`size-10 rounded-full text-sm font-semibold ring-1 transition-colors ${
              on
                ? 'bg-indigo-600 text-white ring-indigo-600'
                : 'bg-slate-100 text-slate-600 ring-slate-300 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:ring-slate-600 dark:hover:bg-slate-600'
            }`}
          >
            {initial}
          </button>
        )
      })}
    </div>
  )
}

/** An optional warm-up/cool-down anchor: pick an event and a length, or none. */
function AnchorEditor({
  label,
  events,
  eventId,
  minutes,
  onChange,
}: {
  label: string
  events: GymEvent[]
  eventId: number | ''
  minutes: string
  onChange: (patch: { eventId?: number | ''; minutes?: string }) => void
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_8rem] sm:items-end">
      <Field label={`${label} event`}>
        <Select
          value={eventId}
          onChange={(e) => onChange({ eventId: e.target.value === '' ? '' : Number(e.target.value) })}
          aria-label={`${label} event`}
        >
          <option value="">None</option>
          {events.map((ev) => (
            <option key={ev.id} value={ev.id}>
              {ev.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={`${label} minutes`}>
        <TextInput
          type="number"
          min={0}
          step={SLOT_MINUTES}
          value={minutes}
          onChange={(e) => onChange({ minutes: e.target.value })}
          disabled={eventId === ''}
          aria-label={`${label} minutes`}
        />
      </Field>
    </div>
  )
}

/**
 * Live feedback while editing: how much of the period is left for eligible
 * events after the warm-up and cool-down, and roughly how many of them fit
 * one period. A class does not visit every eligible event each week — the
 * plan spreads them across four — so this shows the per-period budget, not a
 * total the whole list has to fit inside.
 */
function FitSummary({
  eligibleMinutes,
  periodMinutes,
  warmupMinutes,
  cooldownMinutes,
}: {
  /** Each eligible event's per-class minutes. */
  eligibleMinutes: number[]
  periodMinutes: number
  warmupMinutes: number
  cooldownMinutes: number
}) {
  const middle = periodMinutes - warmupMinutes - cooldownMinutes
  const durations = eligibleMinutes.filter((d) => d > 0).sort((a, b) => a - b)

  // How many of the eligible events fit the middle time, shortest first — the
  // most a period could hold.
  let used = 0
  let fit = 0
  for (const d of durations) {
    if (used + d > middle) break
    used += d
    fit++
  }
  const overflows = durations.length > 0 && durations[0]! > middle

  return (
    <div className="mt-2 space-y-1 rounded-lg bg-slate-50 p-2 text-sm dark:bg-slate-700">
      <p className="font-medium text-slate-700 dark:text-slate-200">
        Middle time: {middle} min ({periodMinutes} − {warmupMinutes} warm-up − {cooldownMinutes}{' '}
        cool-down)
      </p>
      {middle <= 0 ? (
        <p className="font-medium text-red-600 dark:text-red-400">
          ⚠ The warm-up and cool-down leave no time for events.
        </p>
      ) : durations.length === 0 ? (
        <p className="text-slate-500 dark:text-slate-400">
          Add the events this class may rotate through, each with its minutes.
        </p>
      ) : overflows ? (
        <p className="font-medium text-red-600 dark:text-red-400">
          ⚠ The shortest eligible event is longer than the middle time — none fit.
        </p>
      ) : (
        <p className="text-emerald-700 dark:text-emerald-300">
          Up to {fit} of {durations.length} eligible event{durations.length === 1 ? '' : 's'} fit each
          period.
        </p>
      )}
    </div>
  )
}

/** Draft of one eligible event while editing; minutes stays a string. */
interface EligibleDraft {
  eventId: number
  minutes: string
}

/**
 * The class's eligible events, each with the minutes this class spends there.
 * Duration lives here — on the class-event pairing — so the same apparatus can
 * be a different length for another class.
 */
function EligibleEventsEditor({
  events,
  value,
  onChange,
}: {
  events: GymEvent[]
  value: EligibleDraft[]
  onChange: (next: EligibleDraft[]) => void
}) {
  const chosen = new Set(value.map((v) => v.eventId))
  const available = events.filter((e) => !chosen.has(e.id))
  const nameOf = (id: number) => events.find((e) => e.id === id)?.name ?? `#${id}`

  return (
    <div className="space-y-2">
      {value.length === 0 && (
        <p className="text-sm text-slate-400 dark:text-slate-500">
          {events.length === 0
            ? 'Create events first, then add the ones this class rotates through.'
            : 'No eligible events yet — add one below with its minutes.'}
        </p>
      )}
      {value.map((entry, i) => (
        <div key={entry.eventId} className="flex flex-wrap items-center gap-2">
          <span className="min-w-32 text-sm font-medium text-slate-700 dark:text-slate-200">
            {nameOf(entry.eventId)}
          </span>
          <TextInput
            type="number"
            min={SLOT_MINUTES}
            step={SLOT_MINUTES}
            className="max-w-24"
            value={entry.minutes}
            onChange={(e) =>
              onChange(value.map((v, j) => (j === i ? { ...v, minutes: e.target.value } : v)))
            }
            aria-label={`${nameOf(entry.eventId)} minutes`}
          />
          <span className="text-sm text-slate-500 dark:text-slate-400">min</span>
          <Button type="button" variant="danger" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            Remove
          </Button>
        </div>
      ))}
      {available.length > 0 && (
        <Select
          aria-label="add eligible event"
          value=""
          className="max-w-56"
          onChange={(e) => {
            const id = Number(e.target.value)
            if (id) onChange([...value, { eventId: id, minutes: '10' }])
          }}
        >
          <option value="">+ Add event…</option>
          {available.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </Select>
      )}
    </div>
  )
}

export function ClassForm({
  initial,
  events,
  coaches,
  programs,
  others = [],
  onSave,
  onCancel,
}: {
  initial: ClassFormValues
  events: GymEvent[]
  coaches: Coach[]
  programs: Program[]
  /** Other classes, for the "copy setup from" shortcut. */
  others?: GymClass[]
  onSave: (values: ClassFormValues) => Promise<void>
  onCancel?: () => void
}) {
  const [name, setName] = useState(initial.name)
  // Not defaulted into state: programs are still loading on first render,
  // so freezing programs[0] here would leave the select permanently unset.
  const [programId, setProgramId] = useState<number | ''>(initial.programId ?? '')
  const [priority, setPriority] = useState(String(initial.priority))
  const [daysOfWeek, setDaysOfWeek] = useState(initial.daysOfWeek)
  const [startTime, setStartTime] = useState(initial.startTime)
  const toDrafts = (list: GymClass['eligibleEvents']): EligibleDraft[] =>
    list.map((e) => ({ eventId: e.eventId, minutes: String(e.minutes) }))
  const [eligible, setEligible] = useState<EligibleDraft[]>(toDrafts(initial.eligibleEvents))
  const [periodMinutes, setPeriodMinutes] = useState(String(initial.periodMinutes))
  const [warmupEventId, setWarmupEventId] = useState<number | ''>(initial.warmupEventId ?? '')
  const [warmupMinutes, setWarmupMinutes] = useState(String(initial.warmupMinutes))
  const [cooldownEventId, setCooldownEventId] = useState<number | ''>(initial.cooldownEventId ?? '')
  const [cooldownMinutes, setCooldownMinutes] = useState(String(initial.cooldownMinutes))
  const [assignedCoaches, setAssignedCoaches] = useState(initial.assignedCoaches)
  const [error, setError] = useState<string | null>(null)

  const chosenProgramId: number | '' = programId === '' ? (programs[0]?.id ?? '') : programId

  /** Copy another class's whole setup (everything but its name) into the form. */
  const copyFrom = (source: GymClass) => {
    setProgramId(source.programId ?? '')
    setPriority(String(source.priority))
    setDaysOfWeek(source.daysOfWeek)
    setStartTime(source.startTime ?? '')
    setEligible(toDrafts(source.eligibleEvents))
    setPeriodMinutes(String(source.periodMinutes))
    setWarmupEventId(source.warmupEventId ?? '')
    setWarmupMinutes(String(source.warmupMinutes))
    setCooldownEventId(source.cooldownEventId ?? '')
    setCooldownMinutes(String(source.cooldownMinutes))
    setAssignedCoaches(source.assignedCoaches)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const period = Number(periodMinutes)
    if (!Number.isInteger(period) || period < SLOT_MINUTES || period % SLOT_MINUTES !== 0) {
      setError(`Give a period length in minutes (a multiple of ${SLOT_MINUTES}).`)
      return
    }
    const warm = warmupEventId === '' ? 0 : Number(warmupMinutes)
    const cool = cooldownEventId === '' ? 0 : Number(cooldownMinutes)
    if (warm + cool > period) {
      setError("The warm-up and cool-down don't leave any time in the period.")
      return
    }
    const eligibleEvents = []
    for (const draft of eligible) {
      const minutes = Number(draft.minutes)
      if (!Number.isInteger(minutes) || minutes < SLOT_MINUTES || minutes % SLOT_MINUTES !== 0) {
        setError(`Give each eligible event a duration in minutes (a multiple of ${SLOT_MINUTES}).`)
        return
      }
      eligibleEvents.push({ eventId: draft.eventId, minutes })
    }
    try {
      await onSave({
        name,
        programId: chosenProgramId === '' ? null : chosenProgramId,
        priority: Number(priority),
        daysOfWeek,
        startTime,
        eligibleEvents,
        periodMinutes: period,
        warmupEventId: warmupEventId === '' ? null : warmupEventId,
        warmupMinutes: warm,
        cooldownEventId: cooldownEventId === '' ? null : cooldownEventId,
        cooldownMinutes: cool,
        assignedCoaches,
      })
      setName(initial.name)
      setPriority(String(initial.priority))
      setDaysOfWeek(initial.daysOfWeek)
      setStartTime(initial.startTime)
      setEligible(toDrafts(initial.eligibleEvents))
      setPeriodMinutes(String(initial.periodMinutes))
      setWarmupEventId(initial.warmupEventId ?? '')
      setWarmupMinutes(String(initial.warmupMinutes))
      setCooldownEventId(initial.cooldownEventId ?? '')
      setCooldownMinutes(String(initial.cooldownMinutes))
      setAssignedCoaches(initial.assignedCoaches)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed')
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <ErrorNote message={error} />
      {others.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-slate-500 dark:text-slate-400">Copy setup from</span>
          <Select
            aria-label="copy setup from"
            value=""
            onChange={(e) => {
              const source = others.find((c) => c.id === Number(e.target.value))
              if (source) copyFrom(source)
            }}
            className="max-w-56"
          >
            <option value="">another class…</option>
            {others.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <span className="text-xs text-slate-400 dark:text-slate-500">
            fills in everything but the name
          </span>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem_7rem_7rem]">
        <Field label="Class name">
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Tiny Tot 1"
            required
          />
        </Field>
        <Field label="Program">
          <Select
            value={chosenProgramId}
            onChange={(e) => setProgramId(e.target.value === '' ? '' : Number(e.target.value))}
            aria-label="program"
          >
            {programs.length === 0 && <option value="">No programs yet</option>}
            {programs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Period (min)">
          <TextInput
            type="number"
            min={SLOT_MINUTES}
            step={SLOT_MINUTES}
            value={periodMinutes}
            onChange={(e) => setPeriodMinutes(e.target.value)}
            required
          />
        </Field>
        <Field label="Priority">
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
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem] sm:items-end">
        <FieldGroup label="Meets on">
          <DayPicker value={daysOfWeek} onChange={setDaysOfWeek} />
        </FieldGroup>
        <Field label="Start time">
          <TextInput
            type="time"
            step={SLOT_MINUTES * 60}
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            aria-label="start time"
          />
        </Field>
      </div>
      {daysOfWeek.length > 0 && startTime && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          This class joins the{' '}
          {daysOfWeek.map((d) => DAY_FULL[d]).join(', ')} {startTime} session
          {daysOfWeek.length === 1 ? '' : 's'} — generate {daysOfWeek.length === 1 ? 'it' : 'them'} on
          the Sessions page.
        </p>
      )}
      <FieldGroup label="Warm-up and cool-down (optional anchors)">
        <div className="grid gap-3 sm:grid-cols-2">
          <AnchorEditor
            label="Warm-up"
            events={events}
            eventId={warmupEventId}
            minutes={warmupMinutes}
            onChange={(patch) => {
              if (patch.eventId !== undefined) setWarmupEventId(patch.eventId)
              if (patch.minutes !== undefined) setWarmupMinutes(patch.minutes)
            }}
          />
          <AnchorEditor
            label="Cool-down"
            events={events}
            eventId={cooldownEventId}
            minutes={cooldownMinutes}
            onChange={(patch) => {
              if (patch.eventId !== undefined) setCooldownEventId(patch.eventId)
              if (patch.minutes !== undefined) setCooldownMinutes(patch.minutes)
            }}
          />
        </div>
      </FieldGroup>
      <FieldGroup label="Eligible events (with minutes at each)">
        <EligibleEventsEditor events={events} value={eligible} onChange={setEligible} />
        <FitSummary
          eligibleMinutes={eligible.map((e) => Number(e.minutes) || 0)}
          periodMinutes={Number(periodMinutes) || 0}
          warmupMinutes={warmupEventId === '' ? 0 : Number(warmupMinutes) || 0}
          cooldownMinutes={cooldownEventId === '' ? 0 : Number(cooldownMinutes) || 0}
        />
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
  const programsLoad = useLoad(() => apiGet<{ programs: Program[] }>('/api/programs'))
  const [editingId, setEditingId] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const classes = classesLoad.data?.classes ?? []
  const events = eventsLoad.data?.events ?? []
  const coaches = coachesLoad.data?.coaches ?? []
  const programs = programsLoad.data?.programs ?? []

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
    const nameOf = (id: number | null) => (id === null ? null : events.find((e) => e.id === id)?.name)
    const eligible = cls.eligibleEvents
      .map((e) => {
        const name = events.find((ev) => ev.id === e.eventId)?.name
        return name ? `${name} ${e.minutes}′` : null
      })
      .filter(Boolean)
    const warmup = nameOf(cls.warmupEventId)
    const cooldown = nameOf(cls.cooldownEventId)
    const coachNames = cls.assignedCoaches
      .map((id) => coaches.find((c) => c.id === id)?.name)
      .filter(Boolean)
    const schedule =
      cls.daysOfWeek.length > 0 && cls.startTime
        ? `${cls.daysOfWeek.map((d) => DAY_FULL[d]!.slice(0, 3)).join('/')} ${cls.startTime}`
        : 'no day/time set'
    return [
      schedule,
      `${cls.periodMinutes} min period`,
      warmup ? `warm-up ${warmup} ${cls.warmupMinutes}′` : null,
      cooldown ? `cool-down ${cooldown} ${cls.cooldownMinutes}′` : null,
      eligible.length > 0 ? `eligible: ${eligible.join(', ')}` : 'no eligible events',
      coachNames.length > 0 ? `coached by ${coachNames.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join(' · ')
  }

  const emptyForm: ClassFormValues = {
    name: '',
    programId: null,
    priority: 0,
    daysOfWeek: [],
    startTime: '',
    eligibleEvents: [],
    periodMinutes: 45,
    warmupEventId: null,
    warmupMinutes: 0,
    cooldownEventId: null,
    cooldownMinutes: 0,
    assignedCoaches: [],
  }

  // Grouped by program, with anything unassigned last — a class with no
  // program cannot be generated from, so it should be visible, not hidden.
  const groups: { program: Program | null; items: GymClass[] }[] = [
    ...programs.map((program) => ({
      program,
      items: classes.filter((c) => c.programId === program.id),
    })),
    { program: null, items: classes.filter((c) => c.programId === null) },
  ].filter((g) => g.items.length > 0 || g.program !== null)

  return (
    <div className="space-y-4">
      <PageHeader title="Classes" />
      <SetupProgress page="classes" />
      <ErrorNote
        message={
          classesLoad.error ??
          eventsLoad.error ??
          coachesLoad.error ??
          programsLoad.error ??
          actionError
        }
      />
      {programs.length === 0 && (
        <Card>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Classes belong to a program. Add one on the{' '}
            <a className="font-medium text-indigo-600 dark:text-indigo-400" href="/programs">
              Programs
            </a>{' '}
            page first.
          </p>
        </Card>
      )}
      <Card>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Add class
        </h2>
        <ClassForm
          initial={emptyForm}
          events={events}
          coaches={coaches}
          programs={programs}
          others={classes}
          onSave={async (values) => {
            await apiPost('/api/classes', values)
            await classesLoad.reload()
          }}
        />
      </Card>

      {classes.length === 0 && (
        <Card>
          <EmptyNote>No classes yet.</EmptyNote>
        </Card>
      )}
      {groups.map(({ program, items }) => (
        <Card key={program?.id ?? 'none'}>
          <h2 className="mb-1 text-sm font-bold text-slate-900 dark:text-slate-100">
            {program?.name ?? 'No program'}
            <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
              {program?.defaultStartTime
                ? `${program.defaultStartTime}–${program.defaultEndTime}`
                : program
                  ? 'whole session'
                  : 'assign these to a program so they can be generated'}
            </span>
          </h2>
          {items.length === 0 && <EmptyNote>No classes in this program yet.</EmptyNote>}
          <ul className="divide-y divide-slate-100 dark:divide-slate-700">
            {items.map((cls) =>
              editingId === cls.id ? (
                <li key={cls.id} className="py-3">
                  <ClassForm
                    initial={{ ...cls, startTime: cls.startTime ?? '' }}
                    events={events}
                    coaches={coaches}
                    programs={programs}
                    others={classes.filter((c) => c.id !== cls.id)}
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
                    <span className="font-medium text-slate-900 dark:text-slate-100">
                      {cls.name}
                    </span>
                    <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                      priority {cls.priority}
                    </span>
                    {cls.isSample && (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900 dark:text-amber-200">
                        sample
                      </span>
                    )}
                    <p className="text-sm text-slate-500 dark:text-slate-400">{describe(cls)}</p>
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
      ))}
    </div>
  )
}
