import { Link, useParams } from 'react-router-dom'
import type { Coach, GymClass, GymEvent, Placement, Schedule, Session } from '../../shared/types.ts'
import { formatRange, formatTime, rowCount, rowLabel, sessionWindow } from '../../shared/slots.ts'
import { textColorFor } from '../../shared/colors.ts'
import { formatDateLong } from '../../shared/dates.ts'
import { apiGet } from '../lib/api.ts'
import { useLoad } from '../lib/useLoad.ts'
import { Button, ErrorNote } from '../components/ui.tsx'
import { sessionLabel } from '../lib/sessions.ts'

// Print-optimized session schedule: lanes as columns, 5-minute rows, in the
// same event colors as the Excel export, plus per-class "where do I go next"
// strips. Black-and-white friendly: event names are always in text and every
// cell is bordered, so the page reads without color.
//
// Real sessions run 16+ classes, which never fit one portrait page. The
// sheet prints landscape and tiles: columns split into page-sized groups,
// each repeating the time column and its own header row.
const COLUMNS_PER_PAGE = 8

export function PrintPage() {
  const params = useParams()
  const sessionId = Number(params.id)

  const sessionLoad = useLoad(() => apiGet<{ session: Session }>(`/api/sessions/${sessionId}`))
  const eventsLoad = useLoad(() => apiGet<{ events: GymEvent[] }>('/api/events'))
  const classesLoad = useLoad(() => apiGet<{ classes: GymClass[] }>('/api/classes'))
  const coachesLoad = useLoad(() => apiGet<{ coaches: Coach[] }>('/api/coaches'))
  const scheduleLoad = useLoad(() =>
    apiGet<{ schedule: Schedule }>(`/api/sessions/${sessionId}/schedule`),
  )

  const loadError =
    sessionLoad.error ??
    eventsLoad.error ??
    classesLoad.error ??
    coachesLoad.error ??
    scheduleLoad.error
  if (loadError) return <ErrorNote message={loadError} />

  const session = sessionLoad.data?.session
  const schedule = scheduleLoad.data?.schedule
  if (!session || !schedule) return null

  const events = eventsLoad.data?.events ?? []
  const classes = classesLoad.data?.classes ?? []
  const coaches = coachesLoad.data?.coaches ?? []

  const rows = rowCount(session)
  const { startMin, endMin } = sessionWindow(session)
  const rowIndexes = Array.from({ length: rows }, (_, i) => i)
  const eventName = (id: number) => events.find((e) => e.id === id)?.name ?? 'Unknown'
  const eventColor = (id: number) => events.find((e) => e.id === id)?.color ?? '#BAB0AC'
  const className = (id: number) => classes.find((c) => c.id === id)?.name ?? 'Unknown class'
  const coachName = (id: number | null) =>
    id === null ? undefined : coaches.find((c) => c.id === id)?.name

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
          Prints landscape
          {pages.length > 1 &&
            ` — ${columnCount} columns tile across ${pages.length} pages, each repeating the times`}
          .
        </span>
      </div>

      {/*
        A preview of a printed sheet, so it stays black-on-white even in dark
        mode: printing it dark would burn ink and wreck the black-and-white
        legibility this view exists for. On screen it reads as paper on a
        desk; printing drops the sheet chrome.
      */}
      <div className="overflow-x-auto bg-white p-6 text-black shadow-sm dark:shadow-none print:overflow-visible print:p-0 print:shadow-none">
        <h1 className="text-2xl font-black text-black">{sessionLabel(session)}</h1>
        <p className="text-sm font-medium text-slate-700 print:text-black">
          {formatDateLong(session.date)} · {formatRange(startMin, endMin)}
        </p>

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
          <h2 className="text-xl font-black text-black">Where do I go next?</h2>
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
      </div>
    </div>
  )
}
