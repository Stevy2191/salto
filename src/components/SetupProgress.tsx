import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { GymClass, GymEvent, Program, Session } from '../../shared/types.ts'
import { apiGet } from '../lib/api.ts'
import { useLoad } from '../lib/useLoad.ts'

// A first-run helper, not a wizard: it guides the natural build order
// (Events → Programs → Classes → Sessions) with a "Next" link, but every page
// stays a normal, freely-navigable page reachable from the top nav. Once every
// step has data it collapses to nothing, and it can be dismissed at any time.
//
// It layers over the real pages rather than replacing them, so `page` just
// tells it which step to highlight; passing nothing (the Home dashboard) shows
// the overview.

const DISMISS_KEY = 'salto.setupProgress.dismissed'

type Step = 'events' | 'programs' | 'classes' | 'sessions'

const STEPS: { key: Step; label: string; to: string; blurb: string }[] = [
  { key: 'events', label: 'Events', to: '/events', blurb: 'the stations classes rotate through' },
  { key: 'programs', label: 'Programs', to: '/programs', blurb: 'the groupings your classes belong to' },
  {
    key: 'classes',
    label: 'Classes',
    to: '/classes',
    blurb: 'each with its day, time, eligible events and warm-up/cool-down',
  },
  {
    key: 'sessions',
    label: 'Sessions',
    to: '/sessions',
    blurb: 'auto-grouped from your classes — generate each slot’s plan',
  },
]

interface Counts {
  events: number
  programs: number
  classes: number
  sessions: number
}

async function loadCounts(): Promise<Counts> {
  const [events, programs, classes, sessions] = await Promise.all([
    apiGet<{ events: GymEvent[] }>('/api/events'),
    apiGet<{ programs: Program[] }>('/api/programs'),
    apiGet<{ classes: GymClass[] }>('/api/classes'),
    apiGet<{ sessions: Session[] }>('/api/sessions'),
  ])
  return {
    events: events.events.length,
    programs: programs.programs.length,
    classes: classes.classes.length,
    sessions: sessions.sessions.length,
  }
}

export function SetupProgress({ page }: { page?: Step }) {
  const { data } = useLoad(loadCounts)
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISS_KEY) === '1',
  )
  if (!data || dismissed) return null

  const done: Record<Step, boolean> = {
    events: data.events > 0,
    programs: data.programs > 0,
    classes: data.classes > 0,
    sessions: data.sessions > 0,
  }
  // Finished once every step has something — then stay out of the way.
  if (STEPS.every((s) => done[s.key])) return null

  const nextStep = STEPS.find((s) => !done[s.key])
  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, '1')
    setDismissed(true)
  }

  return (
    <div className="rounded-xl bg-indigo-50 p-4 ring-1 ring-indigo-200 dark:bg-indigo-950 dark:ring-indigo-800">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-indigo-900 dark:text-indigo-100">
          Getting set up
        </h2>
        <button
          onClick={dismiss}
          className="text-xs font-medium text-indigo-700 hover:underline dark:text-indigo-300"
        >
          Dismiss
        </button>
      </div>
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        {STEPS.map((step, i) => {
          const isCurrent = page ? step.key === page : step.key === nextStep?.key
          return (
            <li key={step.key} className="flex items-center gap-2">
              {i > 0 && <span className="text-indigo-300 dark:text-indigo-700">→</span>}
              <Link
                to={step.to}
                className={`rounded-lg px-2 py-1 font-medium ${
                  done[step.key]
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : isCurrent
                      ? 'bg-indigo-600 text-white'
                      : 'text-indigo-800 hover:underline dark:text-indigo-200'
                }`}
              >
                {done[step.key] ? '✓ ' : `${i + 1}. `}
                {step.label}
              </Link>
            </li>
          )
        })}
      </ol>
      {nextStep && (
        <p className="mt-2 text-sm text-indigo-900 dark:text-indigo-100">
          Next:{' '}
          <Link to={nextStep.to} className="font-semibold underline">
            {nextStep.label}
          </Link>{' '}
          — {nextStep.blurb}. You can jump to any page from the nav above and come back anytime.
        </p>
      )}
    </div>
  )
}
