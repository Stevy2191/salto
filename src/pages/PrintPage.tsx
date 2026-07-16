import { Link, useParams } from 'react-router-dom'
import type { Coach, GymClass, GymEvent, Placement, Schedule, Session } from '../../shared/types.ts'
import { PLAN_WEEKS } from '../../shared/types.ts'
import { formatRange, formatTime, rowCount, rowLabel, sessionWindow } from '../../shared/slots.ts'
import { textColorFor } from '../../shared/colors.ts'
import { formatDateLong } from '../../shared/dates.ts'
import { apiGet } from '../lib/api.ts'
import { useLoad } from '../lib/useLoad.ts'
import { Button, ErrorNote } from '../components/ui.tsx'
import { sessionLabel } from '../lib/sessions.ts'

// Print-optimized rotation plan: one page (or tiled group of pages) per week,
// lanes as columns, 5-minute rows, in the same event colors as the Excel
// export, plus per-class "where do I go next" strips. Black-and-white
// friendly: event names are always in text and every cell is bordered, so the
// page reads without color.
//
// Real sessions run 16+ classes, which never fit one portrait page. Each week
// prints landscape and tiles: columns split into page-sized groups, each
// repeating the time column and its own header row.
const COLUMNS_PER_PAGE = 8

/** Lookups shared by every week's sheet. */
interface Lookups {
  session: Session
  eventName: (id: number) => string
  eventColor: (id: number) => string
  className: (id: number) => string
  coachName: (id: number | null) => string | undefined
}

export function PrintPage() {
  const params = useParams()
  const sessionId = Number(params.id)

  const sessionLoad = useLoad(() => apiGet<{ session: Session }>(`/api/sessions/${sessionId}`))
  const eventsLoad = useLoad(() => apiGet<{ events: GymEvent[] }>('/api/events'))
  const classesLoad = useLoad(() => apiGet<{ classes: GymClass[] }>('/api/classes'))
  const coachesLoad = useLoad(() => apiGet<{ coaches: Coach[] }>('/api/coaches'))
  // Every week of the plan, each its own printable grid.
  const weeksLoad = useLoad(() =>
    Promise.all(
      Array.from({ length: PLAN_WEEKS }, (_, i) =>
        apiGet<{ schedule: Schedule }>(`/api/sessions/${sessionId}/schedule?week=${i + 1}`).then(
          (r) => r.schedule,
        ),
      ),
    ),
  )

  const loadError =
    sessionLoad.error ??
    eventsLoad.error ??
    classesLoad.error ??
    coachesLoad.error ??
    weeksLoad.error
  if (loadError) return <ErrorNote message={loadError} />

  const session = sessionLoad.data?.session
  const weeks = weeksLoad.data
  if (!session || !weeks) return null

  const events = eventsLoad.data?.events ?? []
  const classes = classesLoad.data?.classes ?? []
  const coaches = coachesLoad.data?.coaches ?? []

  const { startMin, endMin } = sessionWindow(session)
  const lookups: Lookups = {
    session,
    eventName: (id) => events.find((e) => e.id === id)?.name ?? 'Unknown',
    eventColor: (id) => events.find((e) => e.id === id)?.color ?? '#BAB0AC',
    className: (id) => classes.find((c) => c.id === id)?.name ?? 'Unknown class',
    coachName: (id) => (id === null ? undefined : coaches.find((c) => c.id === id)?.name),
  }

  const columnCount = Math.max(session.columnCount, 1)
  const pageCount = Math.ceil(columnCount / COLUMNS_PER_PAGE)

  return (
    <div className="mx-auto max-w-full">
      <div className="mb-4 flex flex-wrap items-center gap-3 print:hidden">
        <Button onClick={() => window.print()}>Print this page</Button>
        <Link
          to={`/sessions/${sessionId}/schedule`}
          className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          ← Back to the editor
        </Link>
        <span className="text-sm text-slate-500 dark:text-slate-400">
          Prints landscape — {PLAN_WEEKS} weeks, each starting a new page
          {pageCount > 1 && `, ${columnCount} columns tiling across ${pageCount} pages`}.
        </span>
      </div>

      {/*
        A preview of the printed sheets, kept black-on-white even in dark mode:
        printing dark would burn ink and wreck the black-and-white legibility
        this view exists for.
      */}
      <div className="overflow-x-auto bg-white p-6 text-black shadow-sm dark:shadow-none print:overflow-visible print:p-0 print:shadow-none">
        <h1 className="text-2xl font-black text-black">{sessionLabel(session)}</h1>
        <p className="text-sm font-medium text-slate-700 print:text-black">
          {formatDateLong(session.date)} · {formatRange(startMin, endMin)} · {PLAN_WEEKS}-week plan
        </p>

        {weeks.map((schedule, i) => (
          <WeekSheet key={i} weekNumber={i + 1} schedule={schedule} lookups={lookups} first={i === 0} />
        ))}
      </div>
    </div>
  )
}

function WeekSheet({
  weekNumber,
  schedule,
  lookups,
  first,
}: {
  weekNumber: number
  schedule: Schedule
  lookups: Lookups
  first: boolean
}) {
  const { session, eventName, eventColor, className, coachName } = lookups
  const rows = rowCount(session)
  const { startMin } = sessionWindow(session)
  const rowIndexes = Array.from({ length: rows }, (_, i) => i)

  const columnCount = Math.max(session.columnCount, 1)
  const pages: number[][] = []
  for (let c = 0; c < columnCount; c += COLUMNS_PER_PAGE) {
    pages.push(Array.from({ length: Math.min(COLUMNS_PER_PAGE, columnCount - c) }, (_, i) => c + i))
  }

  /**
   * What occupies a lane at a given row: the start of a class, the start of
   * an event block, a continuation of either, or nothing. Blocks render with
   * rowSpan so each is one tall cell whose name shows in full.
   */
  const laneAt = (columnIndex: number, rowIndex: number) => {
    const min = startMin + rowIndex * 5
    const placement = schedule.placements.find(
      (p) => p.columnIndex === columnIndex && min >= p.startMin && min < p.endMin,
    )
    if (!placement) return { kind: 'blank' as const }
    if (min === placement.startMin) return { kind: 'class-start' as const, placement }
    const block = placement.blocks.find((b) => min >= b.startMin && min < b.endMin)
    if (!block) return { kind: 'idle' as const }
    if (min === block.startMin) return { kind: 'block-start' as const, block }
    return { kind: 'covered' as const }
  }

  const timeLabel = (i: number) => {
    const label = rowLabel(session, i)
    return label.endsWith(':00') ? label : label.endsWith(':30') ? `:${label.slice(3)}` : ''
  }

  const strips = [...schedule.placements].sort(
    (a, b) => a.columnIndex - b.columnIndex || a.startMin - b.startMin,
  )

  return (
    <section className={first ? undefined : 'break-before-page'}>
      <h2 className="mt-6 text-xl font-black text-black print:mt-0">Week {weekNumber}</h2>
      {pages.map((columns, pageIndex) => (
        <section key={pageIndex} className={pageIndex > 0 ? 'break-before-page' : undefined}>
          {pages.length > 1 && (
            <p className="mt-4 text-xs font-bold uppercase tracking-wide print:mt-0">
              Columns {columns[0]! + 1}–{columns[columns.length - 1]! + 1} of {columnCount}
            </p>
          )}
          <table className="mt-2 w-full border-collapse text-xs">
            {/* Repeats on every printed page of a long table. */}
            <thead className="table-header-group">
              <tr>
                <th
                  className="w-12 border-2 border-black px-1 py-0.5 text-right font-bold"
                  style={{ backgroundColor: '#BFBFBF' }}
                >
                  Time
                </th>
                {columns.map((c) => {
                  const inLane = schedule.placements
                    .filter((p) => p.columnIndex === c)
                    .sort((a, b) => a.startMin - b.startMin)
                  return (
                    <th
                      key={c}
                      className="border-2 border-black px-1 py-0.5 text-left text-sm font-bold"
                      style={{ backgroundColor: '#FFFF00' }}
                    >
                      {inLane.length > 0
                        ? inLane.map((p) => className(p.classId)).join(' → ')
                        : `Column ${c + 1}`}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {rowIndexes.map((i) => (
                <tr key={i} className="break-inside-avoid">
                  <th
                    className="border border-black px-1 text-right align-top text-[10px] font-bold leading-tight"
                    style={{ backgroundColor: '#BFBFBF' }}
                  >
                    {timeLabel(i)}
                  </th>
                  {columns.map((c) => {
                    const cell = laneAt(c, i)
                    // A cell covered by a rowSpan above simply is not there.
                    if (cell.kind === 'covered') return null
                    if (cell.kind === 'blank' || cell.kind === 'idle') {
                      return <td key={c} className="border border-black" />
                    }
                    if (cell.kind === 'class-start') {
                      return (
                        <td
                          key={c}
                          className="border-x-2 border-t-2 border-black px-1 text-[10px] font-bold leading-tight"
                          style={{ backgroundColor: '#FFF2CC' }}
                        >
                          {className(cell.placement.classId)}{' '}
                          <span className="font-normal">
                            {formatRange(cell.placement.startMin, cell.placement.endMin)}
                          </span>
                        </td>
                      )
                    }
                    const { block } = cell
                    const color = eventColor(block.eventId)
                    const coach = coachName(block.coachId)
                    return (
                      <td
                        key={c}
                        rowSpan={(block.endMin - block.startMin) / 5}
                        className="border-2 border-black px-1 align-top text-xs font-semibold leading-tight"
                        style={{ backgroundColor: color, color: textColorFor(color) }}
                      >
                        {eventName(block.eventId)}
                        {coach && <span className="block text-[10px] font-normal">{coach}</span>}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <section className="mt-8 break-before-page print:mt-0">
        <h3 className="text-lg font-black text-black">Week {weekNumber} — where do I go next?</h3>
        <p className="text-sm text-slate-600 print:text-black">
          One strip per class — cut them apart for individual coaches.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {strips.map((p: Placement) => (
            <div
              key={p.id}
              className="break-inside-avoid rounded border-2 border-dashed border-black p-2"
            >
              <span className="text-sm font-bold">
                {className(p.classId)}{' '}
                <span className="font-normal">{formatRange(p.startMin, p.endMin)}</span>
              </span>
              <p className="mt-1 text-sm leading-relaxed">
                {p.blocks.length === 0
                  ? 'No events scheduled.'
                  : [...p.blocks]
                      .sort((a, b) => a.startMin - b.startMin)
                      .map((b) => {
                        const coach = coachName(b.coachId)
                        return `${formatTime(b.startMin)} ${eventName(b.eventId)}${coach ? ` (${coach})` : ''}`
                      })
                      .join('  →  ')}
              </p>
            </div>
          ))}
        </div>
      </section>
    </section>
  )
}
