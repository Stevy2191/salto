import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import ExcelJS from 'exceljs'
import type { Express } from 'express'
import type { Response } from 'superagent'
import { appWithAdmin, createClass, findSlot } from './helpers.ts'
import { textColorFor } from '../../shared/colors.ts'

let app: Express
let cookie: string
let sessionId: number
let vaultId: number
let beamId: number
let lv1: number
let lv2: number
let silver: number
let coachId: number

const VAULT_COLOR = '#E15759' // medium-dark → white text
const BEAM_COLOR = '#EDC948' // light → black text

const T = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h! * 60 + m!
}

// Rows 1–2 are the title/subtitle, row 3 the lane headers, row 4 is 16:00.
const ROW_OF = (hhmm: string) => 4 + (T(hhmm) - T('16:00')) / 5

function binaryParser(res: Response, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = []
  res.on('data', (c: Buffer) => chunks.push(c))
  res.on('end', () => cb(null, Buffer.concat(chunks)))
}

/** Bordered-but-empty cells read back as pattern 'none' — not a solid fill. */
function expectUnfilled(cell: ExcelJS.Cell) {
  const fill = cell.fill
  const solid = fill !== undefined && fill.type === 'pattern' && fill.pattern === 'solid'
  expect(solid).toBe(false)
}

async function downloadSheet(): Promise<{ res: request.Response; sheet: ExcelJS.Worksheet }> {
  const res = await request(app)
    .get(`/api/sessions/${sessionId}/export`)
    .set('Cookie', cookie)
    .buffer(true)
    .parse(binaryParser)
  expect(res.status).toBe(200)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(res.body as Buffer)
  return { res, sheet: workbook.worksheets[0]! }
}

beforeEach(async () => {
  ;({ app, cookie } = await appWithAdmin())
  const post = async (path: string, body: object) =>
    (await request(app).post(path).set('Cookie', cookie).send(body)).body

  vaultId = (await post('/api/events', { name: 'Vault', color: VAULT_COLOR })).event.id
  beamId = (await post('/api/events', { name: 'Beam', color: BEAM_COLOR })).event.id
  coachId = (await post('/api/coaches', { name: 'Dana Marsh' })).coach.id
  // Three classes on the Monday 16:00 slot span it 16:00–18:00 (period 120),
  // giving three lanes. The grid PUT below then paints the arrangement the
  // export assertions expect: lane 0 runs LV 1 then LV 2, lane 1 Xcel Silver.
  const schedule = { daysOfWeek: [1], startTime: '16:00', periodMinutes: 120 }
  lv1 = await createClass(app, cookie, { name: 'LV 1', ...schedule })
  lv2 = await createClass(app, cookie, { name: 'LV 2', ...schedule })
  silver = await createClass(app, cookie, { name: 'Xcel Silver', ...schedule })
  sessionId = (await findSlot(app, cookie, 1, '16:00'))!.id

  await request(app)
    .put(`/api/sessions/${sessionId}/schedule`)
    .set('Cookie', cookie)
    .send({
      placements: [
        {
          classId: lv1,
          columnIndex: 0,
          startMin: T('16:00'),
          endMin: T('17:00'),
          blocks: [
            { eventId: vaultId, coachId, startMin: T('16:05'), endMin: T('16:35') },
            { eventId: beamId, coachId: null, startMin: T('16:35'), endMin: T('17:00') },
          ],
        },
        {
          classId: lv2,
          columnIndex: 0,
          startMin: T('17:00'),
          endMin: T('18:00'),
          // Starts exactly at its class's window start — the case where a
          // header row of its own would shove it down and misreport it.
          blocks: [{ eventId: vaultId, coachId: null, startMin: T('17:00'), endMin: T('17:30') }],
        },
        {
          classId: silver,
          columnIndex: 1,
          startMin: T('16:30'),
          endMin: T('18:00'),
          blocks: [{ eventId: beamId, coachId, startMin: T('16:35'), endMin: T('17:05') }],
        },
      ],
    })
    .expect(200)
})

describe('Excel export', () => {
  it('requires auth and a real session', async () => {
    await request(app).get(`/api/sessions/${sessionId}/export`).expect(401)
    await request(app).get('/api/sessions/9999/export').set('Cookie', cookie).expect(404)
  })

  it('writes one sheet per plan week', async () => {
    const res = await request(app)
      .get(`/api/sessions/${sessionId}/export`)
      .set('Cookie', cookie)
      .buffer(true)
      .parse(binaryParser)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(res.body as Buffer)
    expect(workbook.worksheets.map((w) => w.name)).toEqual(['Week 1', 'Week 2', 'Week 3', 'Week 4'])
    // Only week 1 was painted, so week 2's grid is empty of event blocks.
    const week2 = workbook.worksheets[1]!
    expect(week2.getCell('A1').value).toBe('Monday 4:00 PM — Week 2')
  })

  it('lays lanes out as columns and time as 5-minute rows', async () => {
    const { res, sheet } = await downloadSheet()
    expect(res.headers['content-disposition']).toContain('salto-monday-4-00-pm.xlsx')

    expect(sheet.getCell('A1').value).toBe('Monday 4:00 PM — Week 1')
    expect(String(sheet.getCell('A2').value)).toContain('Monday 4:00 PM · 16:00–18:00')

    // A lane header names the classes it runs, in order — a column is a
    // lane, not a single class.
    expect(sheet.getCell('B3').value).toBe('LV 1 → LV 2')
    expect(sheet.getCell('C3').value).toBe('Xcel Silver')
    for (const ref of ['B3', 'C3']) {
      expect(sheet.getCell(ref).font?.bold).toBe(true)
      expect(sheet.getCell(ref).fill).toMatchObject({ fgColor: { argb: 'FFFFFF00' } })
    }
    // 16:00–18:00 at 5-minute rows.
    expect(sheet.getCell(`A${ROW_OF('17:55')}`).value).toBe(':55')
    expect(sheet.getCell(`A${ROW_OF('18:00')}`).value).toBeFalsy()
  })

  it('prints landscape and repeats the headers and time column across pages', async () => {
    const { sheet } = await downloadSheet()
    // 16+ classes never fit portrait; the sheet tiles instead of shrinking.
    expect(sheet.pageSetup.orientation).toBe('landscape')
    expect(sheet.pageSetup.printTitlesRow).toBe('1:3')
    expect(sheet.pageSetup.printTitlesColumn).toBe('A:A')
  })

  it('labels time rows fully on the hour and compactly between', async () => {
    const { sheet } = await downloadSheet()
    expect(sheet.getCell(`A${ROW_OF('16:00')}`).value).toBe('16:00')
    expect(sheet.getCell(`A${ROW_OF('16:05')}`).value).toBe(':05')
    expect(sheet.getCell(`A${ROW_OF('17:00')}`).value).toBe('17:00')
  })

  it('heads each class block with its name and time range', async () => {
    const { sheet } = await downloadSheet()
    // Each class names itself where its window starts, inside the lane.
    expect(String(sheet.getCell(`B${ROW_OF('16:00')}`).value)).toContain('LV 1')
    expect(String(sheet.getCell(`B${ROW_OF('16:00')}`).value)).toContain('16:00–17:00')
    expect(String(sheet.getCell(`C${ROW_OF('16:30')}`).value)).toContain('Xcel Silver')
  })

  it('never lets the class label push a block off its real time', async () => {
    const { sheet } = await downloadSheet()
    // LV 2 starts at 17:00 with Vault painted from 17:00 — the label rides
    // inside the block rather than stealing a 5-minute row above it, so the
    // block still starts on 17:00 and runs its full 30 minutes.
    const head = sheet.getCell(`B${ROW_OF('17:00')}`)
    expect(String(head.value)).toContain('LV 2')
    expect(String(head.value)).toContain('Vault')
    expect(head.fill).toMatchObject({ fgColor: { argb: `FF${VAULT_COLOR.slice(1)}` } })
    // Filled through 17:25 (the last 5-min row of a 17:00–17:30 block)…
    expect(sheet.getCell(`B${ROW_OF('17:25')}`).fill).toMatchObject({
      fgColor: { argb: `FF${VAULT_COLOR.slice(1)}` },
    })
    // …and not a row further.
    expectUnfilled(sheet.getCell(`B${ROW_OF('17:30')}`))
  })

  it('writes an event block once, with its color carried down the span', async () => {
    const { sheet } = await downloadSheet()
    const head = sheet.getCell(`B${ROW_OF('16:05')}`)
    expect(String(head.value)).toBe('Vault\nDana Marsh')
    // The block is one merged cell so the name shows in full, not clipped
    // into a 5-minute row.
    expect(head.isMerged).toBe(true)
    for (const t of ['16:05', '16:15', '16:30']) {
      expect(sheet.getCell(`B${ROW_OF(t)}`).fill).toMatchObject({
        fgColor: { argb: `FF${VAULT_COLOR.slice(1)}` },
      })
    }
    // Medium edges mark the boundary between neighbouring blocks.
    expect(sheet.getCell(`B${ROW_OF('16:05')}`).border?.top?.style).toBe('medium')
    expect(sheet.getCell(`B${ROW_OF('16:30')}`).border?.bottom?.style).toBe('medium')
  })

  it('leaves blank time inside and outside class windows unfilled', async () => {
    const { sheet } = await downloadSheet()
    // Before Xcel Silver arrives its lane is genuinely blank…
    expectUnfilled(sheet.getCell(`C${ROW_OF('16:00')}`))
    expect(sheet.getCell(`C${ROW_OF('16:00')}`).border?.left?.style).toBe('thin')
    // …as is unpainted time inside a class's own window.
    expectUnfilled(sheet.getCell(`B${ROW_OF('17:45')}`))
  })

  it('renders each lane independently with staggered boundaries', async () => {
    const { sheet } = await downloadSheet()
    // Lane 1's beam block starts at 16:35, mid-way through lane 0's blocks.
    expect(String(sheet.getCell(`C${ROW_OF('16:35')}`).value)).toBe('Beam\nDana Marsh')
    expect(sheet.getCell(`C${ROW_OF('16:35')}`).border?.top?.style).toBe('medium')
    // Lane 0 is on its own block at that moment.
    expect(String(sheet.getCell(`B${ROW_OF('16:35')}`).value)).toBe('Beam')
  })

  it('picks white or black text from the fill brightness', async () => {
    const { sheet } = await downloadSheet()
    expect(sheet.getCell(`B${ROW_OF('16:05')}`).font?.color?.argb).toBe(
      `FF${textColorFor(VAULT_COLOR).slice(1)}`,
    )
    expect(sheet.getCell(`B${ROW_OF('16:35')}`).font?.color?.argb).toBe(
      `FF${textColorFor(BEAM_COLOR).slice(1)}`,
    )
  })
})
