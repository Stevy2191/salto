import { Link } from 'react-router-dom'
import type { GymClass, Program, Session } from '../../shared/types.ts'
import { apiGet } from '../lib/api.ts'
import { useLoad } from '../lib/useLoad.ts'
import { sessionLabel } from '../lib/sessions.ts'
import { Card, EmptyNote, ErrorNote, PageHeader } from '../components/ui.tsx'
import { SetupProgress } from '../components/SetupProgress.tsx'

// Sessions are not created here — they are the weekly (day, start-time) slots
// Salto derives from the classes. This page is a read-only view of those
// slots; the way to change one is to change a class's schedule on the Classes
// page. Each slot links to its repeating 4-week plan.

export function SessionsPage() {
  const sessionsLoad = useLoad(() => apiGet<{ sessions: Session[] }>('/api/sessions'))
  const classesLoad = useLoad(() => apiGet<{ classes: GymClass[] }>('/api/classes'))
  const programsLoad = useLoad(() => apiGet<{ programs: Program[] }>('/api/programs'))

  const sessions = sessionsLoad.data?.sessions ?? []
  const classes = classesLoad.data?.classes ?? []
  const programs = programsLoad.data?.programs ?? []
  const programName = (id: number | null) =>
    id === null ? null : programs.find((p) => p.id === id)?.name

  // Which classes fall in a slot: those meeting its day at its start time.
  const classesIn = (session: Session) =>
    classes.filter(
      (c) => c.startTime === session.startTime && c.daysOfWeek.includes(session.dayOfWeek),
    )

  return (
    <div className="space-y-4">
      <PageHeader title="Sessions" />
      <SetupProgress page="sessions" />
      <ErrorNote message={sessionsLoad.error ?? classesLoad.error ?? programsLoad.error} />
      <Card>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Sessions are grouped automatically from your classes' schedules — each day and start time
          your classes meet becomes a slot below. To add or change one, edit a class on the{' '}
          <Link className="font-medium text-indigo-600 dark:text-indigo-400" to="/classes">
            Classes
          </Link>{' '}
          page.
        </p>
      </Card>
      <Card>
        {sessions.length === 0 && (
          <EmptyNote>
            No slots yet — give a class a day and start time on the{' '}
            <Link className="font-medium text-indigo-600 dark:text-indigo-400" to="/classes">
              Classes
            </Link>{' '}
            page and its slot appears here.
          </EmptyNote>
        )}
        <ul className="divide-y divide-slate-100 dark:divide-slate-700">
          {sessions.map((session) => {
            const inSlot = classesIn(session)
            return (
              <li key={session.id} className="flex flex-wrap items-center gap-2 py-3">
                <div className="flex-1">
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {sessionLabel(session)}
                  </span>
                  {session.isSample && (
                    <span className="ml-2 rounded bg-amber-100 dark:bg-amber-900 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-200">
                      sample
                    </span>
                  )}
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {session.startTime}–{session.endTime} · {session.classCount} class
                    {session.classCount === 1 ? '' : 'es'} · repeating 4-week plan
                  </p>
                  <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
                    {inSlot
                      .map((c) => {
                        const prog = programName(c.programId)
                        return prog ? `${c.name} (${prog})` : c.name
                      })
                      .join(', ')}
                  </p>
                </div>
                <Link
                  to={`/sessions/${session.id}/schedule`}
                  className="min-h-11 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500"
                >
                  Generate / view plan
                </Link>
              </li>
            )
          })}
        </ul>
      </Card>
    </div>
  )
}
