import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { Coach, GymClass, GymEvent, Session } from '../../shared/types.ts'
import { apiDelete, apiGet, apiPost } from '../lib/api.ts'
import { useLoad } from '../lib/useLoad.ts'
import { Button, Card, EmptyNote, ErrorNote, PageHeader } from '../components/ui.tsx'
import { sessionLabel } from '../lib/sessions.ts'
import { SetupProgress } from '../components/SetupProgress.tsx'

interface Overview {
  events: GymEvent[]
  coaches: Coach[]
  classes: GymClass[]
  sessions: Session[]
  exampleLoaded: boolean
}

async function loadOverview(): Promise<Overview> {
  const [events, coaches, classes, sessions, example] = await Promise.all([
    apiGet<{ events: GymEvent[] }>('/api/events'),
    apiGet<{ coaches: Coach[] }>('/api/coaches'),
    apiGet<{ classes: GymClass[] }>('/api/classes'),
    apiGet<{ sessions: Session[] }>('/api/sessions'),
    apiGet<{ loaded: boolean }>('/api/example-gym'),
  ])
  return {
    events: events.events,
    coaches: coaches.coaches,
    classes: classes.classes,
    sessions: sessions.sessions,
    exampleLoaded: example.loaded,
  }
}

/** A new gym: point at the pages, or hand them a gym to poke at. */
function Welcome({ onLoadExample, busy }: { onLoadExample: () => void; busy: boolean }) {
  return (
    <Card>
      <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">Welcome to Salto 👋</h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
        Enter your{' '}
        <Link className="font-medium text-indigo-600 dark:text-indigo-400" to="/events">
          events
        </Link>{' '}
        and{' '}
        <Link className="font-medium text-indigo-600 dark:text-indigo-400" to="/programs">
          programs
        </Link>
        , then add your{' '}
        <Link className="font-medium text-indigo-600 dark:text-indigo-400" to="/classes">
          classes
        </Link>{' '}
        with their day, time and events — your{' '}
        <Link className="font-medium text-indigo-600 dark:text-indigo-400" to="/sessions">
          sessions
        </Link>{' '}
        group themselves from that, ready to generate. Or load a fictional example gym to explore
        first — you can remove it again with one click.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={onLoadExample} disabled={busy}>
          Load example gym
        </Button>
        <Link
          to="/events"
          className="min-h-11 rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 dark:bg-slate-700 dark:text-slate-200 dark:ring-slate-600 dark:hover:bg-slate-600"
        >
          Start with events
        </Link>
      </div>
    </Card>
  )
}

export function Dashboard() {
  const { data, error, loading, reload } = useLoad(loadOverview)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function loadExample() {
    setBusy(true)
    try {
      await apiPost('/api/example-gym')
      setActionError(null)
      await reload()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'could not load example gym')
    } finally {
      setBusy(false)
    }
  }

  async function removeExample() {
    if (!confirm('Remove all example data? Your own entries are kept.')) return
    setBusy(true)
    try {
      await apiDelete('/api/example-gym')
      setActionError(null)
      await reload()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'could not remove example data')
    } finally {
      setBusy(false)
    }
  }

  if (loading || !data) return <ErrorNote message={error} />

  const isEmpty =
    data.events.length === 0 &&
    data.classes.length === 0 &&
    data.coaches.length === 0 &&
    data.sessions.length === 0

  return (
    <div className="space-y-4">
      <PageHeader title="Your sessions" />
      <ErrorNote message={error ?? actionError} />
      {!isEmpty && <SetupProgress />}
      {data.exampleLoaded && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-amber-50 p-4 ring-1 ring-amber-200 dark:bg-amber-950 dark:ring-amber-800">
          <p className="flex-1 text-sm text-amber-800 dark:text-amber-200">
            You're exploring the fictional example gym. Remove it whenever you're ready to enter
            your own gym.
          </p>
          <Button variant="secondary" onClick={() => void removeExample()} disabled={busy}>
            Remove example data
          </Button>
        </div>
      )}
      {isEmpty ? (
        <Welcome onLoadExample={() => void loadExample()} busy={busy} />
      ) : (
        <Card>
          {data.sessions.length === 0 && (
            <EmptyNote>
              No sessions yet — add a class with a day and start time on the{' '}
              <Link className="font-medium text-indigo-600 dark:text-indigo-400" to="/classes">
                Classes
              </Link>{' '}
              page and its slot appears here.
            </EmptyNote>
          )}
          <ul className="divide-y divide-slate-100 dark:divide-slate-700">
            {data.sessions.map((session) => (
              <li key={session.id}>
                <Link
                  to={`/sessions/${session.id}/schedule`}
                  className="flex min-h-14 flex-wrap items-center gap-2 py-3 hover:bg-slate-50 dark:hover:bg-slate-700"
                >
                  <div className="flex-1">
                    <span className="font-medium text-slate-900 dark:text-slate-100">
                      {sessionLabel(session)}
                    </span>
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      {session.startTime}–{session.endTime} · {session.classCount} class
                      {session.classCount === 1 ? '' : 'es'} · repeating 4-week plan
                    </p>
                  </div>
                  <span className="text-sm font-medium text-indigo-600 dark:text-indigo-400">
                    Open schedule →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
