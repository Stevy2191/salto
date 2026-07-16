import { Router } from 'express'
import ExcelJS from 'exceljs'
import type { DatabaseSync } from 'node:sqlite'
import { SLOT_MINUTES, formatRange, formatTime, rowCount, rowStartMin } from '../../shared/slots.ts'
import { textColorFor } from '../../shared/colors.ts'
import { slotLabel } from '../../shared/dates.ts'
import { PLAN_WEEKS } from '../../shared/types.ts'
import type { Placement } from '../../shared/types.ts'
import { ApiError, idParam } from '../validate.ts'
import { loadSchedule } from './schedule.ts'

// Styling matched to the reference sheet (hand-made gym schedule photo):
// bright yellow class header, medium-gray time column, thin black gridlines
// through blocks with medium borders at block boundaries, labels flush left.
const HEADER_FILL = '#FFFF00'
const TIME_FILL = '#BFBFBF'
const CLASS_HEADER_FILL = '#FFF2CC'

const thin = { style: 'thin' as const }
const medium = { style: 'medium' as const }

interface SessionRow {
  id: number
  name: string
  day_of_week: number
  start_time: string
  end_time: string
  column_count: number
}

/** ExcelJS wants ARGB without the leading '#'. */
const argb = (hex: string) => `FF${hex.slice(1).toUpperCase()}`

function solidFill(hex: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(hex) } }
}

/** Excel sheet names: max 31 chars, no \\ / ? * [ ] : */
function sheetName(label: string): string {
  const cleaned = label.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31)
  return cleaned || 'Schedule'
}

function filename(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `salto-${slug || 'schedule'}.xlsx`
}

/** Full time on the hour ("16:00"), compact minutes-only between (":05"). */
function timeLabel(hhmm: string): string {
  return hhmm.endsWith(':00') ? hhmm : `:${hhmm.slice(3)}`
}

export function exportRoutes(db: DatabaseSync): Router {
  const router = Router()

  router.get('/sessions/:id/export', async (req, res) => {
    const sessionId = idParam(req.params.id)
    const session = db
      .prepare(
        'SELECT id, name, day_of_week, start_time, end_time, column_count FROM sessions WHERE id = ?',
      )
      .get(sessionId) as unknown as SessionRow | undefined
    if (!session) throw new ApiError(404, 'session not found')

    const window = { startTime: session.start_time, endTime: session.end_time }
    const label = session.name || slotLabel(session.day_of_week, session.start_time)

    const classNames = new Map(
      (db.prepare('SELECT id, name FROM groups').all() as { id: number; name: string }[]).map(
        (c) => [c.id, c.name],
      ),
    )
    const events = db
      .prepare('SELECT id, name, color FROM events')
      .all() as { id: number; name: string; color: string }[]
    const eventName = (id: number) => events.find((e) => e.id === id)?.name ?? `event #${id}`
    const eventColor = (id: number) => events.find((e) => e.id === id)?.color ?? '#BAB0AC'
    const coachNames = new Map(
      (db.prepare('SELECT id, name FROM coaches').all() as { id: number; name: string }[]).map(
        (c) => [c.id, c.name],
      ),
    )

    const workbook = new ExcelJS.Workbook()
    const rows = rowCount(window)
    const columnCount = Math.max(session.column_count, 1)
    const totalColumns = 1 + columnCount

    // One sheet per plan week, same layout. A rotation plan is four weeks on
    // the same clock, so each week is its own printable grid.
    const buildSheet = (weekNumber: number, placements: Placement[]) => {
    const sheet = workbook.addWorksheet(sheetName(`Week ${weekNumber}`), {
      pageSetup: {
        // 16+ classes never fit portrait; tile across pages instead of
        // shrinking the sheet into illegibility.
        orientation: 'landscape',
        fitToPage: false,
        horizontalCentered: true,
      },
      views: [{ state: 'frozen', xSplit: 1, ySplit: 3 }],
    })
    // The time column and the header rows repeat on every printed page, so
    // a tiled sheet still reads.
    sheet.pageSetup.printTitlesRow = '1:3'
    sheet.pageSetup.printTitlesColumn = 'A:A'

    const HEADER_ROW = 3
    const FIRST_SLOT_ROW = 4
    const rowFor = (min: number) => FIRST_SLOT_ROW + (min - rowStartMin(window, 0)) / SLOT_MINUTES

    // Rows 1–2: session name and week, then date + time range.
    sheet.mergeCells(1, 1, 1, totalColumns)
    const title = sheet.getCell(1, 1)
    title.value = `${label} — Week ${weekNumber}`
    title.font = { bold: true, size: 14 }

    sheet.mergeCells(2, 1, 2, totalColumns)
    const subtitle = sheet.getCell(2, 1)
    subtitle.value = `${slotLabel(session.day_of_week, session.start_time)} · ${session.start_time}–${session.end_time} · repeats weekly`
    subtitle.font = { size: 11, color: { argb: 'FF555555' } }

    // Row 3: column (lane) headers. A column is a lane, not a class, so it
    // is numbered; the classes name themselves inside it.
    const headerRow = sheet.getRow(HEADER_ROW)
    headerRow.getCell(1).value = 'Time'
    headerRow.getCell(1).fill = solidFill(TIME_FILL)
    headerRow.getCell(1).font = { bold: true }
    headerRow.getCell(1).alignment = { horizontal: 'right' }
    headerRow.getCell(1).border = { top: thin, left: thin, right: thin, bottom: medium }
    for (let c = 0; c < columnCount; c++) {
      const cell = headerRow.getCell(c + 2)
      const names = placements
        .filter((p) => p.columnIndex === c)
        .sort((a, b) => a.startMin - b.startMin)
        .map((p) => classNames.get(p.classId) ?? `class #${p.classId}`)
      cell.value = names.join(' → ') || `Column ${c + 1}`
      cell.fill = solidFill(HEADER_FILL)
      cell.font = { bold: true }
      cell.alignment = { horizontal: 'left', wrapText: true }
      cell.border = { top: thin, left: thin, right: thin, bottom: medium }
    }

    // Thin gridlines everywhere first; blocks draw heavier edges over them.
    for (let r = 0; r < rows; r++) {
      for (let c = 1; c <= totalColumns; c++) {
        sheet.getRow(FIRST_SLOT_ROW + r).getCell(c).border = {
          top: thin,
          left: thin,
          right: thin,
          bottom: thin,
        }
      }
    }

    // Time column: full time on the hour, ":MM" between hours.
    for (let r = 0; r < rows; r++) {
      const cell = sheet.getRow(FIRST_SLOT_ROW + r).getCell(1)
      cell.value = timeLabel(formatTime(rowStartMin(window, r)))
      cell.fill = solidFill(TIME_FILL)
      cell.font = { bold: true, size: 9 }
      cell.alignment = { horizontal: 'right', vertical: 'top' }
    }

    // Each placement: a class header, then its painted event blocks.
    for (const p of placements) {
      const column = p.columnIndex + 2
      const headerAt = rowFor(p.startMin)
      const label = `${classNames.get(p.classId) ?? `class #${p.classId}`}  ${formatRange(p.startMin, p.endMin)}`
      // The class names itself at the top of its window. When a block already
      // starts there, the name rides along inside that block instead of
      // taking a row of its own — spending 5 minutes on a label would push
      // the block down and misreport its time.
      const startsOnBlock = p.blocks.some((b) => rowFor(b.startMin) === headerAt)
      if (!startsOnBlock) {
        const headerCell = sheet.getRow(headerAt).getCell(column)
        headerCell.value = label
        headerCell.fill = solidFill(CLASS_HEADER_FILL)
        headerCell.font = { bold: true, size: 9 }
        headerCell.alignment = { horizontal: 'left', vertical: 'middle' }
        headerCell.border = { top: medium, left: medium, right: medium, bottom: thin }
      }

      for (const b of p.blocks) {
        const color = eventColor(b.eventId)
        const first = rowFor(b.startMin)
        const last = rowFor(b.endMin) - 1
        if (last < first) continue
        // Merge the block into one cell so the event name has room to show
        // in full rather than being clipped by a 5-minute row. A merged
        // range styles through its master cell — writing to the others just
        // redirects here — so set fill and borders once, as the outline of
        // the whole block. Medium edges keep the boundary visible even
        // between two same-colored neighbours.
        if (last > first) sheet.mergeCells(first, column, last, column)
        const cell = sheet.getRow(first).getCell(column)
        const coach = b.coachId === null ? undefined : coachNames.get(b.coachId)
        const lines = [
          first === headerAt ? label : null,
          eventName(b.eventId),
          coach ?? null,
        ].filter(Boolean)
        cell.value = lines.join('\n')
        cell.font = { color: { argb: argb(textColorFor(color)) }, size: 9 }
        cell.alignment = { horizontal: 'left', vertical: 'top', wrapText: true }
        cell.fill = solidFill(color)
        cell.border = { left: thin, right: thin, top: medium, bottom: medium }
      }

      // Close the bottom of the class's window so its extent is visible
      // even where nothing is painted. Skip it when a block already ends
      // there — that block's own outline says it, and writing through a
      // merged slave would clobber the master's borders.
      const lastRow = rowFor(p.endMin) - 1
      const endsOnBlock = p.blocks.some((b) => rowFor(b.endMin) - 1 === lastRow)
      if (lastRow >= headerAt && !endsOnBlock) {
        const cell = sheet.getRow(lastRow).getCell(column)
        cell.border = { ...(cell.border ?? {}), bottom: medium }
      }
    }

    sheet.getColumn(1).width = 8
    for (let c = 2; c <= totalColumns; c++) {
      sheet.getColumn(c).width = 18
    }
    for (let r = 0; r < rows; r++) {
      sheet.getRow(FIRST_SLOT_ROW + r).height = 12
    }
    }

    for (let w = 1; w <= PLAN_WEEKS; w++) {
      buildSheet(w, loadSchedule(db, sessionId, w).placements)
    }

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    res.setHeader('Content-Disposition', `attachment; filename="${filename(label)}"`)
    await workbook.xlsx.write(res)
    res.end()
  })

  return router
}
