import { Link, useParams } from 'react-router-dom'
import type { Assignment, Coach, GymClass, GymEvent, Session } from '../../shared/types.ts'
import { slotCount, slotStart } from '../../shared/slots.ts'
import { textColorFor } from '../../shared/colors.ts'
import { DAY_NAMES, apiGet } from '../lib/api.ts'
import { useLoad } from '../lib/useLoad.ts'
import { classBlocks } from '../lib/blocks.ts'
import { Button, ErrorNote } from '../components/ui.tsx'
import { sessionLabel } from './SessionsPage.tsx'

// Print-optimized session schedule: By classes block layout with the same
// event colors as the Excel export, plus per-class "where do I go next"
// strips. Black-and-white friendly: event names are always in text and
// every cell is bordered, so the page reads without color.
export function PrintPage() {
  const params = useParams()
  const sessionId = Number(params.id)

  const sessionLoad = useLoad(() => apiGet<{ session: Session }>(`/api/sessions/${sessionId}`))
  const eventsLoad = useLoad(() => apiGet<{ events: GymEvent[] }>('/api/events'))
  const classesLoad = useLoad(() => apiGet<{ classes: GymClass[] }>('/api/classes'))
  const coachesLoad = useLoad(() => apiGet<{ coaches: Coach[] }>('/api/coaches'))
  const assignmentsLoad = useLoad(() =>
    apiGet<{ assignments: Assignment[] }>(`/api/sessions/${sessionId}/assignments`),
  )

  const loadError =
    sessionLoad.error ??
    eventsLoad.error ??
    classesLoad.error ??
    coachesLoad.error ??
    assignmentsLoad.error
  if (loadError) return <ErrorNote message={loadError} />

  const session = sessionLoad.data?.session
  const assignments = assignmentsLoad.data?.assignments
  if (!session || !assignments) return null

  const events = eventsLoad.data?.events ?? []
  const classes = classesLoad.data?.classes ?? []
  const coaches = coachesLoad.data?.coaches ?? []

  const slots = slotCount(session)
  const slotIndexes = Array.from({ length: slots }, (_, i) => i)
  const columnClasses = classes.filter(
    (g) => session.classes.includes(g.id) || assignments.some((a) => a.classId === g.id),
  )
  const eventName = (id: number) => events.find((e) => e.id === id)?.name ?? 'Unknown'
  const eventColor = (id: number) => events.find((e) => e.id === id)?.color ?? '#BAB0AC'
  const coachName = (id: number | null) =>
    id === null ? undefined : coaches.find((c) => c.id === id)?.name

  const columns = columnClasses.map((cls) => {
    const blocks = classBlocks(assignments, cls.id, slots)
    return {
      cls,
      blocks,
      startMap: new Map(blocks.map((b) => [b.startSlot, b])),
      covered: new Set(
        blocks.flatMap((b) =>
          Array.from({ length: b.length - 1 }, (_, i) => b.startSlot + 1 + i),
        ),
      ),
    }
  })

  const timeLabel = (slot: number) => {
    const label = slotStart(session, slot)
    return label.endsWith(':00') ? label : `:${label.slice(3)}`
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center gap-3 print:hidden">
        <Button onClick={() => window.print()}>Print this page</Button>
        <Link
          to={`/sessions/${sessionId}/schedule`}
          className="text-sm font-medium text-indigo-600 hover:underline"
        >
          ← Back to the editor
        </Link>
      </div>

      <h1 className="text-2xl font-black text-black">{sessionLabel(session)}</h1>
      <p className="text-sm font-medium text-slate-700">
        {DAY_NAMES[session.dayOfWeek]} · {session.startTime}–{session.endTime} ·{' '}
        {session.rotationLength}-minute rotations
      </p>

      <table className="mt-3 w-full border-collapse text-sm">
        <thead>
          <tr>
            <th
              className="w-14 border-2 border-black px-1 py-1 text-right font-bold"
              style={{ backgroundColor: '#BFBFBF' }}
            >
              Time
            </th>
            {columns.map(({ cls }) => (
              <th
                key={cls.id}
                className="border-2 border-black px-2 py-1 text-left text-base font-bold"
                style={{ backgroundColor: '#FFFF00' }}
              >
                {cls.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {slotIndexes.map((slot) => (
            <tr key={slot}>
              <th
                className="border border-black px-1 py-1 text-right align-top font-bold"
                style={{ backgroundColor: '#BFBFBF' }}
              >
                {timeLabel(slot)}
              </th>
              {columns.map(({ cls, startMap, covered }) => {
                if (covered.has(slot)) return null
                const block = startMap.get(slot)
                if (!block) {
                  return <td key={cls.id} className="border border-black" />
                }
                const color = eventColor(block.eventId)
                return (
                  <td
                    key={cls.id}
                    rowSpan={block.length}
                    className="border-2 border-black px-2 py-1 align-top text-base font-semibold"
                    style={{ backgroundColor: color, color: textColorFor(color) }}
                  >
                    {eventName(block.eventId)}
                    {coachName(block.coachId) && (
                      <span className="block text-xs font-normal">
                        {coachName(block.coachId)}
                      </span>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <section className="mt-8 break-before-page print:mt-0">
        <h2 className="text-xl font-black text-black">Where do I go next?</h2>
        <p className="text-sm text-slate-600 print:text-black">
          One strip per class — cut them apart for individual coaches.
        </p>
        <div className="mt-3 space-y-3">
          {columns.map(({ cls, blocks }) => (
            <div
              key={cls.id}
              className="break-inside-avoid rounded border-2 border-dashed border-black p-3"
            >
              <span className="text-base font-bold">{cls.name}</span>
              <p className="mt-1 text-base leading-relaxed">
                {blocks.length === 0
                  ? 'No rotations scheduled.'
                  : blocks
                      .map((b) => {
                        const coach = coachName(b.coachId)
                        return `${slotStart(session, b.startSlot)} ${eventName(b.eventId)}${coach ? ` (${coach})` : ''}`
                      })
                      .join('  →  ')}
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
