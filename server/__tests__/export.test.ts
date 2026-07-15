import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import ExcelJS from 'exceljs'
import type { Express } from 'express'
import type { Response } from 'superagent'
import { appWithAdmin } from './helpers.ts'
import { textColorFor } from '../../shared/colors.ts'

let app: Express
let cookie: string
let sessionId: number
let vaultId: number
let beamId: number
let classAId: number
let classBId: number
let coachId: number

const VAULT_COLOR = '#E15759' // medium-dark → white text
const BEAM_COLOR = '#EDC948' // light → black text

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
  vaultId = (
    await request(app)
      .post('/api/events')
      .set('Cookie', cookie)
      .send({ name: 'Vault', color: VAULT_COLOR })
  ).body.event.id
  beamId = (
    await request(app)
      .post('/api/events')
      .set('Cookie', cookie)
      .send({ name: 'Beam', color: BEAM_COLOR, capacity: 2 })
  ).body.event.id
  classAId = (
    await request(app).post('/api/classes').set('Cookie', cookie).send({ name: 'Level 3 Girls' })
  ).body.class.id
  classBId = (
    await request(app).post('/api/classes').set('Cookie', cookie).send({ name: 'Boys Team' })
  ).body.class.id
  coachId = (
    await request(app).post('/api/coaches').set('Cookie', cookie).send({ name: 'Dana Marsh' })
  ).body.coach.id
  // 16:00–17:00 at 15 min → 4 slots (sheet rows 4–7).
  sessionId = (
    await request(app)
      .post('/api/sessions')
      .set('Cookie', cookie)
      .send({
        name: 'Monday Practice',
        date: '2026-03-02',
        startTime: '16:00',
        endTime: '17:00',
        rotationLength: 15,
        classes: [classAId, classBId],
      })
  ).body.session.id
  // Class A: Vault (2 slots, coached) then Beam (2 slots).
  // Class B: Beam slots 1–2 — staggered against A's boundaries.
  await request(app)
    .put(`/api/sessions/${sessionId}/assignments`)
    .set('Cookie', cookie)
    .send({
      assignments: [
        { slotIndex: 0, eventId: vaultId, classId: classAId, coachId },
        { slotIndex: 1, eventId: vaultId, classId: classAId, coachId },
        { slotIndex: 2, eventId: beamId, classId: classAId, coachId: null },
        { slotIndex: 3, eventId: beamId, classId: classAId, coachId: null },
        { slotIndex: 1, eventId: beamId, classId: classBId, coachId: null },
        { slotIndex: 2, eventId: beamId, classId: classBId, coachId: null },
      ],
    })
    .expect(200)
})

describe('Excel export', () => {
  it('requires auth and a real session', async () => {
    await request(app).get(`/api/sessions/${sessionId}/export`).expect(401)
    await request(app).get('/api/sessions/999/export').set('Cookie', cookie).expect(404)
  })

  it('lays out classes as columns and times as rows', async () => {
    const { res, sheet } = await downloadSheet()
    expect(res.headers['content-disposition']).toContain('salto-monday-practice.xlsx')

    expect(sheet.getCell('A1').value).toBe('Monday Practice')
    // The subtitle names the specific date, not just the weekday.
    expect(String(sheet.getCell('A2').value)).toContain('Monday, March 2, 2026 · 16:00–17:00')

    // Class header row: names in bold on the yellow highlight.
    expect(sheet.getCell('B3').value).toBe('Level 3 Girls')
    expect(sheet.getCell('C3').value).toBe('Boys Team')
    for (const ref of ['B3', 'C3']) {
      expect(sheet.getCell(ref).font?.bold).toBe(true)
      expect(sheet.getCell(ref).alignment?.horizontal).toBe('left')
      expect(sheet.getCell(ref).fill).toMatchObject({ fgColor: { argb: 'FFFFFF00' } })
    }
  })

  it('labels time rows fully on the hour and compactly between', async () => {
    const { sheet } = await downloadSheet()
    expect(sheet.getCell('A4').value).toBe('16:00')
    expect(sheet.getCell('A5').value).toBe(':15')
    expect(sheet.getCell('A6').value).toBe(':30')
    expect(sheet.getCell('A7').value).toBe(':45')
    for (const ref of ['A4', 'A5', 'A6', 'A7']) {
      const cell = sheet.getCell(ref)
      expect(cell.font?.bold).toBe(true)
      expect(cell.alignment?.horizontal).toBe('right')
      expect(cell.fill).toMatchObject({ fgColor: { argb: 'FFBFBFBF' } })
    }
  })

  it('writes multi-slot blocks with the label only in the first cell', async () => {
    const { sheet } = await downloadSheet()

    // Class A's vault block spans rows 4–5.
    expect(sheet.getCell('B4').value).toBe('Vault\nDana Marsh')
    expect(sheet.getCell('B5').value).toBeNull()
    // …but the continuation keeps the event's fill.
    expect(sheet.getCell('B4').fill).toMatchObject({
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE15759' },
    })
    expect(sheet.getCell('B5').fill).toMatchObject({ fgColor: { argb: 'FFE15759' } })

    // Thick borders mark the block boundary: top of the first cell,
    // bottom of the last — so back-to-back blocks stay distinguishable —
    // while thin gridlines continue inside the block (as in the photo).
    expect(sheet.getCell('B4').border?.top?.style).toBe('medium')
    expect(sheet.getCell('B5').border?.top?.style).toBe('thin')
    expect(sheet.getCell('B5').border?.bottom?.style).toBe('medium')
    // The next block (Beam, rows 6–7) starts with its own thick edge.
    expect(sheet.getCell('B6').value).toBe('Beam')
    expect(sheet.getCell('B6').border?.top?.style).toBe('medium')
    expect(sheet.getCell('B6').alignment?.horizontal).toBe('left')
    expect(sheet.getCell('B7').value).toBeNull()
  })

  it('keeps thin gridlines on empty cells', async () => {
    const { sheet } = await downloadSheet()
    // Class B is idle at 16:00 — bordered but unfilled, like the photo.
    const cell = sheet.getCell('C4')
    expectUnfilled(cell)
    expect(cell.border?.top?.style).toBe('thin')
    expect(cell.border?.left?.style).toBe('thin')
  })

  it('renders each class column independently with staggered boundaries', async () => {
    const { sheet } = await downloadSheet()

    // Class B starts at :15 while Class A is mid-block.
    expect(sheet.getCell('C4').value).toBeNull()
    expectUnfilled(sheet.getCell('C4'))
    expect(sheet.getCell('C5').value).toBe('Beam')
    expect(sheet.getCell('C5').border?.top?.style).toBe('medium')
    expect(sheet.getCell('C6').value).toBeNull()
    expect(sheet.getCell('C6').fill).toMatchObject({ fgColor: { argb: 'FFEDC948' } })
    expect(sheet.getCell('C6').border?.bottom?.style).toBe('medium')
    expect(sheet.getCell('C7').value).toBeNull()
    expectUnfilled(sheet.getCell('C7'))
  })

  it('picks white or black text from the fill brightness', async () => {
    const { sheet } = await downloadSheet()
    // Sanity-check the helper's verdicts, then the cells that use them.
    expect(textColorFor(VAULT_COLOR)).toBe('#FFFFFF')
    expect(textColorFor(BEAM_COLOR)).toBe('#000000')
    expect(sheet.getCell('B4').font?.color?.argb).toBe('FFFFFFFF')
    expect(sheet.getCell('B6').font?.color?.argb).toBe('FF000000')
    expect(sheet.getCell('C5').font?.color?.argb).toBe('FF000000')
  })

  it('splits blocks when the coach changes mid-event', async () => {
    await request(app)
      .put(`/api/sessions/${sessionId}/assignments`)
      .set('Cookie', cookie)
      .send({
        assignments: [
          { slotIndex: 0, eventId: vaultId, classId: classAId, coachId },
          { slotIndex: 1, eventId: vaultId, classId: classAId, coachId: null },
        ],
      })
      .expect(200)
    const { sheet } = await downloadSheet()
    expect(sheet.getCell('B4').value).toBe('Vault\nDana Marsh')
    expect(sheet.getCell('B5').value).toBe('Vault')
    expect(sheet.getCell('B4').border?.bottom?.style).toBe('medium')
    expect(sheet.getCell('B5').border?.top?.style).toBe('medium')
  })
})
