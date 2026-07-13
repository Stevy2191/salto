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
let groupId: number
let coachId: number

const VAULT_COLOR = '#E15759'
const BEAM_COLOR = '#EDC948'

function binaryParser(res: Response, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = []
  res.on('data', (c: Buffer) => chunks.push(c))
  res.on('end', () => cb(null, Buffer.concat(chunks)))
}

async function downloadWorkbook(): Promise<{ res: request.Response; sheet: ExcelJS.Worksheet }> {
  const res = await request(app)
    .get(`/api/sessions/${sessionId}/export`)
    .set('Cookie', cookie)
    .buffer(true)
    .parse(binaryParser)
  expect(res.status).toBe(200)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(res.body as Buffer)
  const sheet = workbook.worksheets[0]!
  expect(sheet).toBeDefined()
  return { res, sheet }
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
      .send({ name: 'Beam', color: BEAM_COLOR })
  ).body.event.id
  groupId = (
    await request(app).post('/api/groups').set('Cookie', cookie).send({ name: 'Level 3 Girls' })
  ).body.group.id
  coachId = (
    await request(app).post('/api/coaches').set('Cookie', cookie).send({ name: 'Dana Marsh' })
  ).body.coach.id
  // 16:00–17:00 at 30 min → 2 slots
  sessionId = (
    await request(app)
      .post('/api/sessions')
      .set('Cookie', cookie)
      .send({
        name: 'Monday Practice',
        dayOfWeek: 1,
        startTime: '16:00',
        endTime: '17:00',
        rotationLength: 30,
        groups: [groupId],
      })
  ).body.session.id
  await request(app)
    .put(`/api/sessions/${sessionId}/assignments`)
    .set('Cookie', cookie)
    .send({
      assignments: [
        { slotIndex: 0, eventId: vaultId, groupId, coachId },
        { slotIndex: 1, eventId: beamId, groupId, coachId: null },
      ],
    })
    .expect(200)
})

describe('Excel export', () => {
  it('requires auth and a real session', async () => {
    await request(app).get(`/api/sessions/${sessionId}/export`).expect(401)
    await request(app).get('/api/sessions/999/export').set('Cookie', cookie).expect(404)
  })

  it('downloads a valid xlsx with headers and layout', async () => {
    const { res, sheet } = await downloadWorkbook()
    expect(res.headers['content-type']).toContain('spreadsheetml')
    expect(res.headers['content-disposition']).toContain('salto-monday-practice.xlsx')

    expect(sheet.getCell('A1').value).toBe('Monday Practice')
    expect(String(sheet.getCell('A2').value)).toContain('Monday · 16:00–17:00 · 30-minute rotations')

    // Header row: Time | Vault | Beam. Time slots down column A.
    expect(sheet.getCell('A3').value).toBe('Time')
    expect(sheet.getCell('B3').value).toBe('Vault')
    expect(sheet.getCell('C3').value).toBe('Beam')
    expect(sheet.getCell('A4').value).toBe('16:00')
    expect(sheet.getCell('A5').value).toBe('16:30')
  })

  it('fills cells with the event color and readable text', async () => {
    const { sheet } = await downloadWorkbook()

    // Header cells wear their event color.
    const vaultHeader = sheet.getCell('B3')
    expect(vaultHeader.fill).toMatchObject({
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE15759' },
    })

    // Occupied cell: fill + contents + auto-contrast font.
    const vaultCell = sheet.getCell('B4')
    expect(vaultCell.value).toBe('Level 3 Girls — Dana Marsh')
    expect(vaultCell.fill).toMatchObject({ fgColor: { argb: 'FFE15759' } })
    // #E15759 is medium-dark → white text
    expect(textColorFor(VAULT_COLOR)).toBe('#FFFFFF')
    expect(vaultCell.font?.color?.argb).toBe('FFFFFFFF')

    // Light yellow beam → black text; no coach listed.
    const beamCell = sheet.getCell('C5')
    expect(beamCell.value).toBe('Level 3 Girls')
    expect(beamCell.fill).toMatchObject({ fgColor: { argb: 'FFEDC948' } })
    expect(beamCell.font?.color?.argb).toBe('FF000000')

    // Empty cells stay unfilled.
    const emptyCell = sheet.getCell('C4')
    expect(emptyCell.value).toBeNull()
    expect(emptyCell.fill?.type ?? 'none').not.toBe('pattern')
  })

  it('stacks multiple groups in one cell when capacity allows', async () => {
    const secondGroup = (
      await request(app).post('/api/groups').set('Cookie', cookie).send({ name: 'Boys Team' })
    ).body.group.id
    await request(app)
      .put(`/api/sessions/${sessionId}/assignments`)
      .set('Cookie', cookie)
      .send({
        assignments: [
          { slotIndex: 0, eventId: vaultId, groupId, coachId: null },
          { slotIndex: 0, eventId: vaultId, groupId: secondGroup, coachId: null },
        ],
      })
      .expect(200)

    const { sheet } = await downloadWorkbook()
    expect(sheet.getCell('B4').value).toBe('Level 3 Girls\nBoys Team')
  })
})
