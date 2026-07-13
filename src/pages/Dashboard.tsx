import { Link } from 'react-router-dom'
import type { Session } from '../../shared/types.ts'
import { DAY_NAMES, apiGet } from '../lib/api.ts'
import { useLoad } from '../lib/useLoad.ts'
import { Card, EmptyNote, ErrorNote, PageHeader } from '../components/ui.tsx'
import { sessionLabel } from './SessionsPage.tsx'

export function Dashboard() {
  const { data, error, loading } = useLoad(() => apiGet<{ sessions: Session[] }>('/api/sessions'))
  const sessions = data?.sessions ?? []

  return (
    <div className="space-y-4">
      <PageHeader title="Your sessions" />
      <ErrorNote message={error} />
      <Card>
        {!loading && sessions.length === 0 && (
          <EmptyNote>
            No sessions yet — set up your gym via the navigation above, then create a session.
          </EmptyNote>
        )}
        <ul className="divide-y divide-slate-100">
          {sessions.map((session) => (
            <li key={session.id}>
              <Link
                to={`/sessions/${session.id}/schedule`}
                className="flex min-h-14 flex-wrap items-center gap-2 py-3 hover:bg-slate-50"
              >
                <div className="flex-1">
                  <span className="font-medium text-slate-900">{sessionLabel(session)}</span>
                  <p className="text-sm text-slate-500">
                    {DAY_NAMES[session.dayOfWeek]} {session.startTime}–{session.endTime}
                  </p>
                </div>
                <span className="text-sm font-medium text-indigo-600">Open schedule →</span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
