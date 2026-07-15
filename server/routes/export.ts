import { Router } from 'express'
import ExcelJS from 'exceljs'
import type { DatabaseSync } from 'node:sqlite'
import { slotCount, slotStart } from '../../shared/slots.ts'
import { textColorFor } from '../../shared/colors.ts'
import { formatDateLong, formatDateShort } from '../../shared/dates.ts'
import { ApiError, idParam } from '../validate.ts'

// Styling matched to the reference sheet (hand-made gym schedule photo):
// bright yellow class header, medium-gray time column, thin black gridlines
// through blocks with medium borders at block boundaries, labels flush left.
const HEADER_FILL = '#FFFF00'
const TIME_FILL = '#BFBFBF'

const thin = { style: 'thin' as const }
const medium = { style: 'medium' as const }

interface SessionRow {
  id: number
  name: string
  date: string
  start_time: string
  end_time: string
  rotation_length: number
  groups: string
}

interface AssignmentRow {
  slot_index: number
  event_id: number
  group_id: number
  coach_id: number | null
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

/**
 * One class's column, sliced into blocks: consecutive slots on the same
 * event with the same coach. Each class's blocks stand alone — rotation
 * boundaries may be staggered across classes.
 */
interface CellBlock {
  startSlot: number
  length: number
  label: string
  color: string
}

function blocksForClass(
  slots: number,
  cellsBySlot: Map<number, AssignmentRow[]>,
  eventName: (id: number) => string,
  eventColor: (id: number) => string,
  coachName: (id: number) => string | undefined,
): CellBlock[] {
  const keyOf = (list: AssignmentRow[]) =>
    list.map((a) => `${a.event_id}:${a.coach_id ?? ''}`).join('|')
  const blocks: CellBlock[] = []
  let current: (CellBlock & { key: string }) | null = null
  for (let slot = 0; slot < slots; slot++) {
    const here = cellsBySlot.get(slot) ?? []
    if (here.length === 0) {
      current = null
      continue
    }
    const key = keyOf(here)
    if (current && current.key === key) {
      current.length++
      continue
    }
    const labels = here.map((a) => {
      const coach = a.coach_id === null ? undefined : coachName(a.coach_id)
      return coach ? `${eventName(a.event_id)}\n${coach}` : eventName(a.event_id)
    })
    current = {
      key,
      startSlot: slot,
      length: 1,
      label: labels.join(' / '),
      color: eventColor(here[0]!.event_id),
    }
    blocks.push(current)
  }
  return blocks
}

export function exportRoutes(db: DatabaseSync): Router {
  const router = Router()

  router.get('/sessions/:id/export', async (req, res) => {
    const sessionId = idParam(req.params.id)
    const session = db
      .prepare(
        'SELECT id, name, date, start_time, end_time, rotation_length, groups FROM sessions WHERE id = ?',
      )
      .get(sessionId) as unknown as SessionRow | undefined
    if (!session) throw new ApiError(404, 'session not found')

    const window = {
      startTime: session.start_time,
      endTime: session.end_time,
      rotationLength: session.rotation_length,
    }
    const label = session.name || `${formatDateShort(session.date)} ${session.start_time}`

    const assignments = db
      .prepare(
        'SELECT slot_index, event_id, group_id, coach_id FROM assignments WHERE session_id = ? ORDER BY slot_index, event_id, group_id',
      )
      .all(sessionId) as unknown as AssignmentRow[]

    // Columns: the session's classes in their stored order, plus any class
    // that has assignments here (e.g. removed from the session later).
    const classNamesById = new Map(
      (db.prepare('SELECT id, name FROM groups').all() as { id: number; name: string }[]).map(
        (g) => [g.id, g.name],
      ),
    )
    const sessionClassIds = JSON.parse(session.groups) as number[]
    const columnClassIds = [
      ...sessionClassIds,
      ...[...new Set(assignments.map((a) => a.group_id))].filter(
        (id) => !sessionClassIds.includes(id),
      ),
    ].filter((id) => classNamesById.has(id))

    const events = db
      .prepare('SELECT id, name, color FROM events')
      .all() as { id: number; name: string; color: string }[]
    const eventName = (id: number) => events.find((e) => e.id === id)?.name ?? `event #${id}`
    const eventColor = (id: number) => events.find((e) => e.id === id)?.color ?? '#BAB0AC'
    const coachNamesById = new Map(
      (db.prepare('SELECT id, name FROM coaches').all() as { id: number; name: string }[]).map(
        (c) => [c.id, c.name],
      ),
    )

    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet(sheetName(label), {
      pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    })
    const columnCount = 1 + columnClassIds.length
    const slots = slotCount(window)
    const HEADER_ROW = 3
    const FIRST_SLOT_ROW = 4

    // Rows 1–2: session name, then day + time range + rotation.
    sheet.mergeCells(1, 1, 1, columnCount)
    const title = sheet.getCell(1, 1)
    title.value = label
    title.font = { bold: true, size: 14 }

    sheet.mergeCells(2, 1, 2, columnCount)
    const subtitle = sheet.getCell(2, 1)
    subtitle.value = `${formatDateLong(session.date)} · ${session.start_time}–${session.end_time} · ${session.rotation_length}-minute rotations`
    subtitle.font = { size: 11, color: { argb: 'FF555555' } }

    // Row 3: class names, bold on a yellow highlight.
    const headerRow = sheet.getRow(HEADER_ROW)
    headerRow.getCell(1).value = 'Time'
    headerRow.getCell(1).fill = solidFill(TIME_FILL)
    headerRow.getCell(1).font = { bold: true }
    headerRow.getCell(1).alignment = { horizontal: 'right' }
    headerRow.getCell(1).border = { top: thin, left: thin, right: thin, bottom: medium }
    columnClassIds.forEach((classId, i) => {
      const cell = headerRow.getCell(i + 2)
      cell.value = classNamesById.get(classId)!
      cell.fill = solidFill(HEADER_FILL)
      cell.font = { bold: true }
      cell.alignment = { horizontal: 'left' }
      cell.border = { top: thin, left: thin, right: thin, bottom: medium }
    })

    // Full grid of thin black borders first — the reference sheet shows
    // gridlines even through blocks and empty cells; block boundaries get
    // heavier edges in the block pass below.
    for (let slot = 0; slot < slots; slot++) {
      for (let c = 1; c <= columnCount; c++) {
        sheet.getRow(FIRST_SLOT_ROW + slot).getCell(c).border = {
          top: thin,
          left: thin,
          right: thin,
          bottom: thin,
        }
      }
    }

    // Time column: full time on the hour, ":MM" between hours.
    for (let slot = 0; slot < slots; slot++) {
      const cell = sheet.getRow(FIRST_SLOT_ROW + slot).getCell(1)
      cell.value = timeLabel(slotStart(window, slot))
      cell.fill = solidFill(TIME_FILL)
      cell.font = { bold: true }
      cell.alignment = { horizontal: 'right', vertical: 'top' }
    }

    // Class columns, each rendered independently from its own assignments —
    // block starts/ends may be staggered arbitrarily across classes.
    columnClassIds.forEach((classId, i) => {
      const column = i + 2
      const cellsBySlot = new Map<number, AssignmentRow[]>()
      for (const a of assignments) {
        if (a.group_id !== classId) continue
        const list = cellsBySlot.get(a.slot_index)
        if (list) list.push(a)
        else cellsBySlot.set(a.slot_index, [a])
      }
      const blocks = blocksForClass(slots, cellsBySlot, eventName, eventColor, (id) =>
        coachNamesById.get(id),
      )
      for (const block of blocks) {
        const font = { color: { argb: argb(textColorFor(block.color)) } }
        for (let offset = 0; offset < block.length; offset++) {
          const cell = sheet.getRow(FIRST_SLOT_ROW + block.startSlot + offset).getCell(column)
          // Event name only in the first cell; continuations keep the fill.
          if (offset === 0) {
            cell.value = block.label
            cell.font = font
            cell.alignment = { horizontal: 'left', vertical: 'top', wrapText: true }
          }
          cell.fill = solidFill(block.color)
          // Medium top/bottom edges mark block boundaries even between
          // same-colored neighbors; thin gridlines continue inside blocks.
          cell.border = {
            left: thin,
            right: thin,
            top: offset === 0 ? medium : thin,
            bottom: offset === block.length - 1 ? medium : thin,
          }
        }
      }
    })

    sheet.getColumn(1).width = 9
    for (let c = 2; c <= columnCount; c++) {
      sheet.getColumn(c).width = 20
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
