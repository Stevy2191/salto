import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { Coach, Group, GymEvent, Session } from '../../shared/types.ts'
import { DAY_NAMES, apiDelete, apiGet, apiPost } from '../lib/api.ts'
import { useLoad } from '../lib/useLoad.ts'
import { Button, Card, EmptyNote, ErrorNote, PageHeader } from '../components/ui.tsx'
import { sessionLabel } from './SessionsPage.tsx'

interface Overview {
  events: GymEvent[]
  coaches: Coach[]
  groups: Group[]
  sessions: Session[]
  exampleLoaded: boolean
}

async function loadOverview(): Promise<Overview> {
  const [events, coaches, groups, sessions, example] = await Promise.all([
    apiGet<{ events: GymEvent[] }>('/api/events'),
    apiGet<{ coaches: Coach[] }>('/api/coaches'),
    apiGet<{ groups: Group[] }>('/api/groups'),
    apiGet<{ sessions: Session[] }>('/api/sessions'),
    apiGet<{ loaded: boolean }>('/api/example-gym'),
  ])
  return {
    events: events.events,
    coaches: coaches.coaches,
    groups: groups.groups,
    sessions: sessions.sessions,
    exampleLoaded: example.loaded,
  }
}

function GuidedSetup({ overview, onLoadExample }: { overview: Overview; onLoadExample: () => void }) {
  const steps = [
    {
      to: '/events',
      title: 'Add your events',
      detail: 'Vault, bars, beam, floor — whatever stations your gym has.',
      done: overview.events.length > 0,
    },
    {
      to: '/groups',
      title: 'Add your groups',
      detail: 'Each training group, its priority, and which events it needs.',
      done: overview.groups.length > 0,
    },
    {
      to: '/coaches',
      title: 'Add your coaches',
      detail: 'Who coaches what, and which days they work.',
      done: overview.coaches.length > 0,
    },
    {
      to: '/sessions',
      title: 'Create your first session',
      detail: 'A practice block with its time window and attending groups.',
      done: overview.sessions.length > 0,
    },
  ]
  const nextIndex = steps.findIndex((s) => !s.done)

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="text-lg font-bold text-slate-900">Welcome to Salto 👋</h2>
        <p className="mt-1 text-sm text-slate-600">
          Set up your gym in four steps, or load a fictional example gym to explore first — you can
          remove it again with one click.
        </p>
        <div className="mt-3">
          <Button onClick={onLoadExample}>Load example gym</Button>
        </div>
      </Card>
      <ol className="space-y-2">
        {steps.map((step, index) => (
          <li key={step.to}>
            <Link
              to={step.to}
              className={`flex items-center gap-3 rounded-xl bg-white p-4 ring-1 transition-shadow hover:shadow ${
                index === nextIndex ? 'ring-2 ring-indigo-500' : 'ring-slate-200'
              }`}
            >
              <span
                className={`flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                  step.done ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'
                }`}
              >
                {step.done ? '✓' : index + 1}
              </span>
              <span>
                <span className="block font-medium text-slate-900">{step.title}</span>
                <span className="block text-sm text-slate-500">{step.detail}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
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
    data.groups.length === 0 &&
    data.coaches.length === 0 &&
    data.sessions.length === 0

  if (isEmpty) {
    return (
      <div className="space-y-4">
        <ErrorNote message={error ?? actionError} />
        <GuidedSetup overview={data} onLoadExample={() => void loadExample()} />
      </div>
    )
  }

  const setupIncomplete =
    data.events.length === 0 ||
    data.groups.length === 0 ||
    data.coaches.length === 0 ||
    data.sessions.length === 0

  return (
    <div className="space-y-4">
      <PageHeader title="Your sessions" />
      <ErrorNote message={error ?? actionError} />
      {data.exampleLoaded && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-amber-50 p-4 ring-1 ring-amber-200">
          <p className="flex-1 text-sm text-amber-800">
            You're exploring the fictional example gym. Remove it whenever you're ready to enter
            your own gym.
          </p>
          <Button variant="secondary" onClick={() => void removeExample()} disabled={busy}>
            Remove example data
          </Button>
        </div>
      )}
      {setupIncomplete && <GuidedSetup overview={data} onLoadExample={() => void loadExample()} />}
      {!setupIncomplete && (
        <Card>
          {data.sessions.length === 0 && <EmptyNote>No sessions yet.</EmptyNote>}
          <ul className="divide-y divide-slate-100">
            {data.sessions.map((session) => (
              <li key={session.id}>
                <Link
                  to={`/sessions/${session.id}/schedule`}
                  className="flex min-h-14 flex-wrap items-center gap-2 py-3 hover:bg-slate-50"
                >
                  <div className="flex-1">
                    <span className="font-medium text-slate-900">{sessionLabel(session)}</span>
                    <p className="text-sm text-slate-500">
                      {DAY_NAMES[session.dayOfWeek]} {session.startTime}–{session.endTime} ·{' '}
                      {session.groups.length} group{session.groups.length === 1 ? '' : 's'}
                    </p>
                  </div>
                  <span className="text-sm font-medium text-indigo-600">Open schedule →</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
