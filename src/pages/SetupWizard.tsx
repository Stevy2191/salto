import { useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import type { Coach, Group, GymEvent, Session } from '../../shared/types.ts'
import { apiDelete, apiGet, apiPost } from '../lib/api.ts'
import { useLoad } from '../lib/useLoad.ts'
import { Button, Card, ErrorNote } from '../components/ui.tsx'
import { EventForm } from './EventsPage.tsx'
import { GroupForm } from './GroupsPage.tsx'
import { CoachForm } from './CoachesPage.tsx'
import { SessionForm, sessionLabel } from './SessionsPage.tsx'

// Single source of truth for the guided setup steps — the dashboard
// checklist links into these wizard routes.
export const SETUP_STEPS = [
  {
    slug: 'events',
    short: 'Events',
    title: 'Add your events',
    detail: 'Vault, bars, beam, floor — whatever stations your gym has.',
  },
  {
    slug: 'groups',
    short: 'Groups',
    title: 'Add your groups',
    detail: 'Each training group, its priority, and which events it needs.',
  },
  {
    slug: 'coaches',
    short: 'Coaches',
    title: 'Add your coaches',
    detail: 'Who coaches what, and which days they work.',
  },
  {
    slug: 'session',
    short: 'First session',
    title: 'Create your first session',
    detail: 'A practice block with its time window and attending groups.',
  },
] as const

function ItemList({
  items,
  onDelete,
}: {
  items: { id: number; label: string; swatch?: string }[]
  onDelete: (id: number) => void
}) {
  if (items.length === 0) return null
  return (
    <ul className="mt-4 divide-y divide-slate-100 border-t border-slate-100">
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-2 py-2">
          {item.swatch && (
            <span
              className="size-3 shrink-0 rounded-full ring-1 ring-black/10"
              style={{ backgroundColor: item.swatch }}
            />
          )}
          <span className="flex-1 text-sm font-medium text-slate-800">{item.label}</span>
          <button
            onClick={() => onDelete(item.id)}
            className="min-h-9 rounded px-2 text-sm text-red-500 hover:bg-red-50"
          >
            Remove
          </button>
        </li>
      ))}
    </ul>
  )
}

export function SetupWizard() {
  const params = useParams()
  const navigate = useNavigate()
  const stepIndex = SETUP_STEPS.findIndex((s) => s.slug === params.step)

  const eventsLoad = useLoad(() => apiGet<{ events: GymEvent[] }>('/api/events'))
  const groupsLoad = useLoad(() => apiGet<{ groups: Group[] }>('/api/groups'))
  const coachesLoad = useLoad(() => apiGet<{ coaches: Coach[] }>('/api/coaches'))
  const sessionsLoad = useLoad(() => apiGet<{ sessions: Session[] }>('/api/sessions'))
  const [createdSessionId, setCreatedSessionId] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  if (stepIndex === -1) return <Navigate to={`/guide/${SETUP_STEPS[0].slug}`} replace />

  const loading =
    eventsLoad.loading || groupsLoad.loading || coachesLoad.loading || sessionsLoad.loading
  const loadError =
    eventsLoad.error ?? groupsLoad.error ?? coachesLoad.error ?? sessionsLoad.error
  if (loadError) return <ErrorNote message={loadError} />
  if (loading) return null

  const events = eventsLoad.data?.events ?? []
  const groups = groupsLoad.data?.groups ?? []
  const coaches = coachesLoad.data?.coaches ?? []
  const sessions = sessionsLoad.data?.sessions ?? []
  const stepDone = [
    events.length > 0,
    groups.length > 0,
    coaches.length > 0,
    sessions.length > 0,
  ]
  const step = SETUP_STEPS[stepIndex]!
  const isLast = stepIndex === SETUP_STEPS.length - 1

  const removeItem = async (path: string, reload: () => Promise<void>) => {
    try {
      await apiDelete(path)
      setActionError(null)
      await reload()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'delete failed')
    }
  }

  const finish = () => {
    const target =
      createdSessionId ??
      (sessions.length > 0 ? Math.max(...sessions.map((s) => s.id)) : null)
    navigate(target === null ? '/' : `/sessions/${target}/schedule?welcome=1`)
  }

  const stepBody = () => {
    switch (step.slug) {
      case 'events':
        return (
          <>
            <p className="text-sm text-slate-600">
              Events are the stations groups rotate through. Most gyms have several — add as
              many as you like; one is enough to move on.
            </p>
            <EventForm
              initial={{ name: '', capacity: 1, active: true, color: null }}
              onSave={async ({ color, ...rest }) => {
                await apiPost('/api/events', color === null ? rest : { ...rest, color })
                await eventsLoad.reload()
              }}
            />
            <ItemList
              items={events.map((e) => ({ id: e.id, label: e.name, swatch: e.color }))}
              onDelete={(id) => void removeItem(`/api/events/${id}`, eventsLoad.reload)}
            />
          </>
        )
      case 'groups':
        return (
          <>
            <p className="text-sm text-slate-600">
              Groups are who trains — "Level 3 Girls", "Boys Team". Set what each group needs
              in a session; you can refine durations later.
            </p>
            <GroupForm
              initial={{ name: '', priority: 0, requiredEvents: [], assignedCoaches: [] }}
              events={events}
              coaches={coaches}
              onSave={async (values) => {
                await apiPost('/api/groups', values)
                await groupsLoad.reload()
              }}
            />
            <ItemList
              items={groups.map((g) => ({ id: g.id, label: g.name }))}
              onDelete={(id) => void removeItem(`/api/groups/${id}`, groupsLoad.reload)}
            />
          </>
        )
      case 'coaches':
        return (
          <>
            <p className="text-sm text-slate-600">
              Add your coaches, what they coach, and the days they work. You can assign them to
              groups now or later.
            </p>
            <CoachForm
              initial={{ name: '', specialties: [], availability: [] }}
              events={events}
              onSave={async (values) => {
                await apiPost('/api/coaches', values)
                await coachesLoad.reload()
              }}
            />
            <ItemList
              items={coaches.map((c) => ({ id: c.id, label: c.name }))}
              onDelete={(id) => void removeItem(`/api/coaches/${id}`, coachesLoad.reload)}
            />
          </>
        )
      case 'session':
        return (
          <>
            <p className="text-sm text-slate-600">
              A session is one practice block. Your groups are pre-selected — save it and
              you're done.
            </p>
            <SessionForm
              initial={{
                name: '',
                dayOfWeek: 1,
                startTime: '16:00',
                endTime: '18:00',
                rotationLength: 15,
                groups: groups.map((g) => g.id),
              }}
              groups={groups}
              onSave={async (values) => {
                const res = await apiPost<{ session: Session }>('/api/sessions', values)
                setCreatedSessionId(res.session.id)
                await sessionsLoad.reload()
              }}
            />
            <ItemList
              items={sessions.map((s) => ({ id: s.id, label: sessionLabel(s) }))}
              onDelete={(id) => void removeItem(`/api/sessions/${id}`, sessionsLoad.reload)}
            />
          </>
        )
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="space-y-2">
        <p className="text-sm font-semibold uppercase tracking-wide text-indigo-600">
          Step {stepIndex + 1} of {SETUP_STEPS.length}
        </p>
        <div className="flex flex-wrap gap-2">
          {SETUP_STEPS.map((s, i) => (
            <Link
              key={s.slug}
              to={`/guide/${s.slug}`}
              aria-current={i === stepIndex ? 'step' : undefined}
              className={`min-h-9 rounded-full px-3 py-1.5 text-sm font-medium ${
                i === stepIndex
                  ? 'bg-indigo-600 text-white'
                  : stepDone[i]
                    ? 'bg-green-100 text-green-800'
                    : 'bg-slate-100 text-slate-500'
              }`}
            >
              {stepDone[i] && i !== stepIndex ? '✓ ' : ''}
              {s.short}
            </Link>
          ))}
        </div>
        <h1 className="text-xl font-bold text-slate-900">{step.title}</h1>
      </div>

      <ErrorNote message={actionError} />
      <Card className="space-y-4">{stepBody()}</Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {stepIndex > 0 && (
            <Button
              variant="secondary"
              onClick={() => navigate(`/guide/${SETUP_STEPS[stepIndex - 1]!.slug}`)}
            >
              ← Back
            </Button>
          )}
        </div>
        <div className="flex items-center gap-4">
          <Link to="/" className="text-sm text-slate-500 hover:underline">
            Exit setup
          </Link>
          {isLast ? (
            <Button onClick={finish} disabled={!stepDone[stepIndex]}>
              Finish → open the schedule
            </Button>
          ) : (
            <Button
              onClick={() => navigate(`/guide/${SETUP_STEPS[stepIndex + 1]!.slug}`)}
              disabled={!stepDone[stepIndex]}
            >
              Next →
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
