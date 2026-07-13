import { Router } from 'express'
import ExcelJS from 'exceljs'
import type { DatabaseSync } from 'node:sqlite'
import { slotCount, slotStart } from '../../shared/slots.ts'
import { textColorFor } from '../../shared/colors.ts'
import { ApiError, idParam } from '../validate.ts'

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

interface SessionRow {
  id: number
  name: string
  day_of_week: number
  start_time: string
  end_time: string
  rotation_length: number
}

interface EventRow {
  id: number
  name: string
  active: number
  color: string
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

export function exportRoutes(db: DatabaseSync): Router {
  const router = Router()

  router.get('/sessions/:id/export', async (req, res) => {
    const sessionId = idParam(req.params.id)
    const session = db
      .prepare('SELECT id, name, day_of_week, start_time, end_time, rotation_length FROM sessions WHERE id = ?')
      .get(sessionId) as unknown as SessionRow | undefined
    if (!session) throw new ApiError(404, 'session not found')

    const window = {
      startTime: session.start_time,
      endTime: session.end_time,
      rotationLength: session.rotation_length,
    }
    const label =
      session.name || `${DAY_NAMES[session.day_of_week]} ${session.start_time}`

    const assignments = db
      .prepare(
        'SELECT slot_index, event_id, group_id, coach_id FROM assignments WHERE session_id = ? ORDER BY slot_index, event_id, group_id',
      )
      .all(sessionId) as unknown as AssignmentRow[]

    // Same column rule as the on-screen grid: active events, plus inactive
    // ones that still hold assignments.
    const allEvents = db
      .prepare('SELECT id, name, active, color FROM events ORDER BY id')
      .all() as unknown as EventRow[]
    const events = allEvents.filter(
      (e) => e.active === 1 || assignments.some((a) => a.event_id === e.id),
    )

    const groupNames = new Map(
      (db.prepare('SELECT id, name FROM groups').all() as { id: number; name: string }[]).map(
        (g) => [g.id, g.name],
      ),
    )
    const coachNames = new Map(
      (db.prepare('SELECT id, name FROM coaches').all() as { id: number; name: string }[]).map(
        (c) => [c.id, c.name],
      ),
    )

    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet(sheetName(label), {
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    })
    const columnCount = 1 + events.length

    // Row 1: session name. Row 2: day + time range + rotation.
    sheet.mergeCells(1, 1, 1, columnCount)
    const title = sheet.getCell(1, 1)
    title.value = label
    title.font = { bold: true, size: 14 }

    sheet.mergeCells(2, 1, 2, columnCount)
    const subtitle = sheet.getCell(2, 1)
    subtitle.value = `${DAY_NAMES[session.day_of_week]} · ${session.start_time}–${session.end_time} · ${session.rotation_length}-minute rotations`
    subtitle.font = { size: 11, color: { argb: 'FF555555' } }

    // Row 3: header — Time, then one column per event, filled with its color.
    const headerRow = sheet.getRow(3)
    headerRow.getCell(1).value = 'Time'
    headerRow.getCell(1).font = { bold: true }
    events.forEach((event, i) => {
      const cell = headerRow.getCell(i + 2)
      cell.value = event.active === 1 ? event.name : `${event.name} (inactive)`
      cell.fill = solidFill(event.color)
      cell.font = { bold: true, color: { argb: argb(textColorFor(event.color)) } }
      cell.alignment = { vertical: 'middle', wrapText: true }
    })

    // Rows 4+: one row per time slot; occupied cells filled with the
    // event color, listing "Group — Coach" per assignment.
    const slots = slotCount(window)
    for (let slot = 0; slot < slots; slot++) {
      const row = sheet.getRow(4 + slot)
      row.getCell(1).value = slotStart(window, slot)
      row.getCell(1).font = { bold: true }
      row.getCell(1).alignment = { vertical: 'top' }

      events.forEach((event, i) => {
        const here = assignments.filter(
          (a) => a.slot_index === slot && a.event_id === event.id,
        )
        if (here.length === 0) return
        const cell = row.getCell(i + 2)
        cell.value = here
          .map((a) => {
            const group = groupNames.get(a.group_id) ?? 'Unknown group'
            const coach = a.coach_id === null ? null : (coachNames.get(a.coach_id) ?? null)
            return coach ? `${group} — ${coach}` : group
          })
          .join('\n')
        cell.fill = solidFill(event.color)
        cell.font = { color: { argb: argb(textColorFor(event.color)) } }
        cell.alignment = { vertical: 'top', wrapText: true }
      })
    }

    sheet.getColumn(1).width = 9
    for (let c = 2; c <= columnCount; c++) {
      sheet.getColumn(c).width = 24
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
