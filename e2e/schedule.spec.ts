import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// One serial journey against a single fresh database: first run, the lane
// grid and its editing (place → paint → move → resize → erase), generation +
// day-of repair, the print view, session copying, and the dark mode toggle.
test.describe.configure({ mode: 'serial' })

/** Row height in the grid, in px — must match src/pages/schedule/grid.ts. */
const ROW_H = 28

type Loc = ReturnType<Page['locator']>

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill('e2e-password-1')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('link', { name: 'Home' })).toBeVisible()
}

/**
 * The grid writes on pointer-release. Await the actual PUT, not the "Saved"
 * label: it reads "Saved" before anything happens, so waiting on it passes
 * instantly and races whatever is asserted next.
 */
function saveOf(page: Page) {
  return page.waitForResponse(
    (r) => r.request().method() === 'PUT' && r.url().includes('/schedule'),
  )
}

/** A pointer drag in a straight line, in several steps like a real hand. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    )
  }
  await page.mouse.up()
}

/**
 * Paint or erase across a class's rows, counted from the top of its window.
 * Presses mid-row, as a hand does: the top and bottom few pixels of a block
 * are its resize handles.
 */
async function dragRows(page: Page, placement: Loc, from: number, to: number) {
  const box = (await placement.boundingBox())!
  const x = box.x + box.width / 2
  const y = (row: number) => box.y + row * ROW_H + ROW_H / 2
  const saved = saveOf(page)
  await drag(page, { x, y: y(from) }, { x, y: y(to) })
  await saved
}

/** Grab a block by its body and move it down (or up) by whole rows. */
async function moveBlockRows(page: Page, block: Loc, rows: number, { expectSave = true } = {}) {
  await block.scrollIntoViewIfNeeded()
  const b = (await block.boundingBox())!
  const x = b.x + b.width / 2
  const y = b.y + b.height / 2 // the body, clear of both edge handles
  const saved = expectSave ? saveOf(page) : null
  await drag(page, { x, y }, { x, y: y + rows * ROW_H })
  if (saved) await saved
}

/** Wipe a class's window so a test can paint exactly what it needs. */
async function clearLane(page: Page, placement: Loc) {
  await openEditTools(page)
  await page.getByRole('button', { name: 'erase' }).click()
  await dragRows(page, placement, 0, 12)
  await expect(placement.locator('[data-testid^="block-"]')).toHaveCount(0)
}

/** Drag a block's bottom edge by whole rows. */
async function resizeBlockRows(page: Page, block: Loc, rows: number) {
  await block.scrollIntoViewIfNeeded()
  const b = (await block.boundingBox())!
  const x = b.x + b.width / 2
  const y = b.y + b.height - 3 // inside the bottom resize handle
  const saved = saveOf(page)
  await drag(page, { x, y }, { x, y: y + rows * ROW_H })
  await saved
}

/**
 * The hand-editing tools sit behind a disclosure now that generating is the
 * primary path, so anything touching them has to open it first.
 */
async function openEditTools(page: Page) {
  if (await page.getByRole('button', { name: 'erase' }).isHidden()) {
    await page.getByText('Edit by hand').click()
  }
  await expect(page.getByRole('button', { name: 'erase' })).toBeVisible()
}

/**
 * Add a lane and wait for it to actually exist. `expected` is the resulting
 * number of lanes — counting first would race the grid's own first render.
 */
async function addColumn(page: Page, expected: number) {
  await openEditTools(page)
  await expect(page.getByRole('button', { name: '+ Add class' })).toHaveCount(expected - 1)
  await page.getByRole('button', { name: '+ Add column' }).click()
  await expect(page.getByRole('button', { name: '+ Add class' })).toHaveCount(expected)
}

// First-run smoke test: create the admin account, then walk the guided
// setup wizard end to end and land on the new session's schedule grid.
test('first run: enter the gym structure, then generate from it', async ({ page }) => {
  await page.goto('/')

  // Fresh database → admin account creation.
  await expect(page).toHaveURL(/\/setup$/)
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel(/^Password/).fill('e2e-password-1')
  await page.getByLabel('Confirm password').fill('e2e-password-1')
  await page.getByRole('button', { name: 'Create admin account' }).click()

  // An empty gym points straight at the pages — there is no wizard.
  await expect(page.getByText('Welcome to Salto')).toBeVisible()
  await page.getByRole('link', { name: 'Start with events' }).click()
  await expect(page).toHaveURL(/\/events$/)

  // Events are facility-wide. Warm-up is open mat space (no limit); the
  // Tumble Trak takes one class at a time, which is what makes this a
  // puzzle worth generating.
  for (const [name, limit] of [
    ['Warm-up', ''],
    ['Tumble Trak', '1'],
    ['Vault', '1'],
    ['Beam', '1'],
  ] as const) {
    await page.getByLabel('Event name').fill(name)
    await page.getByLabel(/Class limit/).fill(limit)
    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect(page.getByText(name, { exact: true })).toBeVisible()
  }

  // A program, on its own clock.
  await page.getByRole('link', { name: 'Programs' }).click()
  await expect(page).toHaveURL(/\/programs$/)
  await page.getByLabel('Program name').fill('Preschool')
  await page.getByLabel('default start time').fill('16:00')
  await page.getByLabel('default end time').fill('17:00')
  await page.getByRole('button', { name: 'Save' }).first().click()
  await expect(page.getByText('2 classes · 16:00–17:00')).toBeHidden()
  await expect(page.getByText('Preschool', { exact: true })).toBeVisible()

  // Two classes in it. Each warms up first, and both want the one Trak.
  await page.getByRole('link', { name: 'Classes' }).click()
  await expect(page).toHaveURL(/\/classes$/)
  for (const name of ['Tiny Tot 1', 'Tiny Tot 2']) {
    const form = page.locator('form').first()
    await form.getByLabel('Class name').fill(name)
    await form.getByRole('button', { name: '+ Add event' }).click()
    await form.getByRole('button', { name: '+ Add event' }).click()
    await form.getByRole('combobox', { name: 'event' }).nth(0).selectOption({ label: 'Warm-up' })
    await form.getByLabel('duration in minutes').nth(0).fill('15')
    await form.getByRole('combobox', { name: 'position' }).nth(0).selectOption('FIRST')
    await form
      .getByRole('combobox', { name: 'event' })
      .nth(1)
      .selectOption({ label: 'Tumble Trak' })
    await form.getByLabel('duration in minutes').nth(1).fill('15')
    // 30 min of events against Preschool's 60-min clock — visible before
    // ever hitting Generate.
    await expect(page.getByText('Total required: 30 min')).toBeVisible()
    await expect(page.getByText(/Window 16:00–17:00 .* fits with 30 min spare/)).toBeVisible()
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(name, { exact: true })).toBeVisible()
  }

  // A coach.
  await page.getByRole('link', { name: 'Coaches' }).click()
  await page.getByLabel('Coach name').fill('Dana Marsh')
  await page.getByRole('button', { name: 'Save' }).first().click()
  await expect(page.getByText('Dana Marsh', { exact: true })).toBeVisible()

  // A session, and gather the program into it.
  await page.getByRole('link', { name: 'Sessions' }).click()
  await page.getByLabel(/session name/i).fill('Monday Practice')
  await page.getByLabel('Date').fill('2026-03-02')
  await page.getByRole('button', { name: 'Save' }).first().click()
  await expect(page.getByText(/Monday, March 2, 2026/)).toBeVisible()

  await page.getByRole('link', { name: 'Home' }).click()
  await page.getByRole('link', { name: /Monday Practice/ }).click()
  await expect(page.getByRole('heading', { name: 'Monday Practice' })).toBeVisible()
  await page.getByRole('button', { name: 'Add whole program' }).click()

  // Both classes land on their program's clock, and — because they run at
  // the same time — take a lane each.
  await expect(page.getByText('Tiny Tot 1 16:00–17:00')).toBeVisible()
  await expect(page.getByText('Tiny Tot 2 16:00–17:00')).toBeVisible()
})

test('Generate builds the whole rotation from the structure', async ({ page }) => {
  await login(page)
  await page.goto('/sessions/1/schedule')
  await expect(page.getByText('Tiny Tot 1 16:00–17:00')).toBeVisible()

  await page.getByRole('button', { name: 'Generate schedule' }).click()

  // Every class got all of its events, without anyone painting anything.
  const lanes = page.locator('[data-testid^="placement-"]')
  await expect(lanes).toHaveCount(2)
  for (const i of [0, 1]) {
    await expect(lanes.nth(i).locator('[data-testid^="block-"]')).toHaveCount(2)
  }

  // The warm-up anchor holds: it is the first thing each class does.
  for (const i of [0, 1]) {
    await expect(lanes.nth(i).locator('[data-testid^="block-"]').first()).toContainText('Warm-up')
  }

  // The core constraint: the capacity-1 Trak is never double-booked. Both
  // classes need it in the same hour, so the generator had to stagger them.
  const traks = page.locator('[data-testid^="block-"]').filter({ hasText: 'Tumble Trak' })
  await expect(traks).toHaveCount(2)
  const boxes = await Promise.all([0, 1].map(async (i) => (await traks.nth(i).boundingBox())!))
  const [a, b] = boxes.sort((x, y) => x.y - y.y)
  expect(a!.y + a!.height).toBeLessThanOrEqual(Math.round(b!.y) + 1)

  // And it survives a reload — Generate wrote.
  await page.reload()
  await expect(page.locator('[data-testid^="block-"]')).toHaveCount(4)
})

test('Generate explains an over-subscribed shared event instead of failing silently', async ({
  page,
}) => {
  // Regenerating over existing blocks asks first; say yes.
  page.on('dialog', (d) => void d.accept())
  await login(page)
  // Make both classes want the whole hour on the one Trak: impossible.
  await page.goto('/classes')
  for (const name of ['Tiny Tot 1', 'Tiny Tot 2']) {
    const row = page.getByRole('listitem').filter({ hasText: name })
    await row.getByRole('button', { name: 'Edit' }).click()
    const form = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('button', { name: 'Cancel' }) })
    await form.getByLabel('duration in minutes').nth(1).fill('60')
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(name, { exact: true })).toBeVisible()
  }

  await page.goto('/sessions/1/schedule')
  await page.getByRole('button', { name: 'Generate schedule' }).click()

  // Named, specific, and about the event that is actually the problem.
  await expect(page.getByText("Couldn't generate")).toBeVisible()
  await expect(page.getByText(/Tumble Trak is over-subscribed: 2 classes need 120 min/)).toBeVisible()

  // Put it back for the tests that follow.
  await page.goto('/classes')
  for (const name of ['Tiny Tot 1', 'Tiny Tot 2']) {
    const row = page.getByRole('listitem').filter({ hasText: name })
    await row.getByRole('button', { name: 'Edit' }).click()
    const form = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('button', { name: 'Cancel' }) })
    await form.getByLabel('duration in minutes').nth(1).fill('15')
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(name, { exact: true })).toBeVisible()
  }
})

test('place classes into a lane with their own windows, stacked in time', async ({ page }) => {
  await login(page)

  // Two more classes to stack.
  await page.goto('/classes')
  for (const name of ['LV 1', 'LV 2']) {
    await page.getByLabel('Class name').fill(name)
    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect(page.getByText(name, { exact: true })).toBeVisible()
  }

  await page.goto('/sessions/1/schedule')
  await addColumn(page, 3)

  // LV 1 takes the first hour of the new lane…
  await page.getByRole('button', { name: '+ Add class' }).nth(2).click()
  await page.getByRole('combobox', { name: 'Class' }).selectOption({ label: 'LV 1' })
  await page.getByLabel('class starts').fill('16:00')
  await page.getByLabel('class ends').fill('17:00')
  await page.getByRole('button', { name: 'Add class', exact: true }).click()
  await expect(page.getByText('LV 1 16:00–17:00')).toBeVisible()

  // …and LV 2 stacks directly after it in the SAME lane.
  await page.getByRole('button', { name: '+ Add class' }).nth(2).click()
  await page.getByRole('combobox', { name: 'Class' }).selectOption({ label: 'LV 2' })
  await page.getByLabel('class starts').fill('17:00')
  await page.getByLabel('class ends').fill('18:00')
  await page.getByRole('button', { name: 'Add class', exact: true }).click()
  await expect(page.getByText('LV 2 17:00–18:00')).toBeVisible()

  // The lane header names the sequence it runs.
  await expect(page.getByText('LV 1 → LV 2')).toBeVisible()
})

test('a column holds one class at a time — overlaps are rejected', async ({ page }) => {
  await login(page)
  await page.goto('/sessions/1/schedule')

  // LV 1 already runs 16:00–17:00 in that lane; try to overlap it.
  await page.getByRole('button', { name: '+ Add class' }).nth(2).click()
  await page.getByRole('combobox', { name: 'Class' }).selectOption({ label: 'Tiny Tot 1' })
  await page.getByLabel('class starts').fill('16:30')
  await page.getByLabel('class ends').fill('17:30')
  await page.getByRole('button', { name: 'Add class', exact: true }).click()

  // Refused, and said so — the placement is not created.
  await expect(page.getByText(/column .* holds one class at a time/i)).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByText('Tiny Tot 1 16:30–17:30')).not.toBeVisible()
})

test('blank cells show outside a class window, never a forced fill', async ({ page }) => {
  await login(page)
  await page.goto('/sessions/1/schedule')

  // LV 1 runs 16:00–17:00 and LV 2 runs 17:00–18:00, so their lane is
  // covered — but a class placed on a partial window leaves real blanks.
  await addColumn(page, 4)
  await page.getByRole('button', { name: '+ Add class' }).nth(3).click()
  await page.getByRole('combobox', { name: 'Class' }).selectOption({ label: 'LV 1' })
  await page.getByLabel('class starts').fill('17:00')
  await page.getByLabel('class ends').fill('17:30')
  await page.getByRole('button', { name: 'Add class', exact: true }).click()

  // Find it by its own header rather than by DOM order: saving swaps the
  // placement's local id for the server's, so anything positional can be
  // looking at a detached element.
  const partial = page
    .locator('[data-testid^="placement-"]')
    .filter({ hasText: 'LV 1 17:00–17:30' })
  await expect(partial).toHaveCount(1)

  // The placement covers only its own window — 30 of the session's 120
  // minutes — leaving the rest of the lane blank rather than filled.
  await expect
    .poll(async () => Math.round((await partial.boundingBox())?.height ?? 0))
    .toBe((30 / 5) * ROW_H)
})

test('drag to paint an event across several 5-minute blocks', async ({ page }) => {
  await login(page)
  await page.goto('/sessions/1/schedule')

  // Tiny Tot 1 runs 16:00–17:00 in the first lane.
  const lane = page.locator('[data-testid^="placement-"]').first()
  await clearLane(page, lane)

  // Drag six rows: 30 minutes of Beam, from 16:10.
  await page.getByRole('button', { name: 'paint Beam' }).click()
  await dragRows(page, lane, 2, 8)

  const beam = lane.locator('[data-testid^="block-"]').first()
  await expect(beam).toContainText('Beam')
  expect(Math.round((await beam.boundingBox())!.height)).toBe(6 * ROW_H)

  // It survives a reload — the drag really wrote.
  await page.reload()
  await expect(lane.locator('[data-testid^="block-"]').first()).toContainText('Beam')
})

test('painting across an existing block overwrites what it crosses', async ({ page }) => {
  await login(page)
  await page.goto('/sessions/1/schedule')
  const lane = page.locator('[data-testid^="placement-"]').first()
  await clearLane(page, lane)
  await page.getByRole('button', { name: 'paint Beam' }).click()
  await dragRows(page, lane, 2, 8)

  // Start on empty grid below and drag up through the Beam. Pressing the
  // block itself would move it — that is the point of the distinction — so
  // overwriting is done by painting across from open time.
  await page.getByRole('button', { name: 'paint Vault' }).click()
  await dragRows(page, lane, 10, 6)

  await page.reload()
  const blocks = lane.locator('[data-testid^="block-"]')
  await expect(blocks).toHaveCount(2)
  // Beam was trimmed back to where Vault begins; Vault took the rest.
  await expect(blocks.nth(0)).toContainText('Beam')
  await expect(blocks.nth(1)).toContainText('Vault')
  expect(Math.round((await blocks.nth(0).boundingBox())!.height)).toBe(4 * ROW_H)
})

test('a block moves by its body, keeping its duration and snapping to rows', async ({ page }) => {
  await login(page)
  await page.goto('/sessions/1/schedule')
  const lane = page.locator('[data-testid^="placement-"]').first()
  await clearLane(page, lane)
  await page.getByRole('button', { name: 'paint Beam' }).click()
  await dragRows(page, lane, 2, 6) // 16:10–16:30

  const beam = lane.locator('[data-testid^="block-"]').first()
  const before = (await beam.boundingBox())!
  await moveBlockRows(page, beam, 6)

  await page.reload()
  const moved = (await lane.locator('[data-testid^="block-"]').first().boundingBox())!
  // Same duration, six rows later, landed on a clean row boundary.
  expect(Math.round(moved.height)).toBe(Math.round(before.height))
  const lanePos = (await lane.boundingBox())!
  expect(Math.round((moved.y - lanePos.y) / ROW_H)).toBe(8)
})

test('a move onto a sibling is refused, not silently eaten', async ({ page }) => {
  await login(page)
  await page.goto('/sessions/1/schedule')
  const lane = page.locator('[data-testid^="placement-"]').first()
  await clearLane(page, lane)
  await page.getByRole('button', { name: 'paint Beam' }).click()
  await dragRows(page, lane, 0, 4) // 16:00–16:20
  await page.getByRole('button', { name: 'paint Vault' }).click()
  await dragRows(page, lane, 4, 8) // 16:20–16:40

  // Drag Vault up onto Beam. Nothing is written and nothing is destroyed.
  const vault = lane.locator('[data-testid^="block-"]').nth(1)
  await moveBlockRows(page, vault, -2, { expectSave: false })

  await page.reload()
  const blocks = lane.locator('[data-testid^="block-"]')
  await expect(blocks).toHaveCount(2)
  await expect(blocks.nth(0)).toContainText('Beam')
  await expect(blocks.nth(1)).toContainText('Vault')
})

test('dragging a block edge resizes it, snapping to 5 minutes', async ({ page }) => {
  await login(page)
  await page.goto('/sessions/1/schedule')
  const lane = page.locator('[data-testid^="placement-"]').first()
  await clearLane(page, lane)
  await page.getByRole('button', { name: 'paint Beam' }).click()
  await dragRows(page, lane, 2, 6) // 16:10–16:30

  const beam = lane.locator('[data-testid^="block-"]').first()
  await expect(beam).toBeVisible()
  const before = (await beam.boundingBox())!
  const laneBefore = (await lane.boundingBox())!
  await resizeBlockRows(page, beam, 3)

  await page.reload()
  const after = (await lane.locator('[data-testid^="block-"]').first().boundingBox())!
  const laneAfter = (await lane.boundingBox())!
  expect(Math.round(after.height)).toBe(Math.round(before.height) + 3 * ROW_H)
  // The top edge did not move — a resize is not a move. Measured against
  // the lane, since a reload closes the edit disclosure and shifts the page.
  expect(Math.round(after.y - laneAfter.y)).toBe(Math.round(before.y - laneBefore.y))
})

test('a resize stops at the neighbouring block instead of eating it', async ({ page }) => {
  await login(page)
  await page.goto('/sessions/1/schedule')
  const lane = page.locator('[data-testid^="placement-"]').first()
  await clearLane(page, lane)
  await page.getByRole('button', { name: 'paint Beam' }).click()
  await dragRows(page, lane, 0, 4) // 16:00–16:20
  await page.getByRole('button', { name: 'paint Vault' }).click()
  await dragRows(page, lane, 8, 12) // 16:40–17:00

  const blocks = lane.locator('[data-testid^="block-"]')
  await resizeBlockRows(page, blocks.first(), 20)

  await page.reload()
  await expect(lane.locator('[data-testid^="block-"]')).toHaveCount(2)
  // The edge stopped exactly where the neighbour begins. Lane-relative,
  // because a reload closes the edit disclosure and shifts the page.
  const laneBox = (await lane.boundingBox())!
  const grown = (await blocks.first().boundingBox())!
  const neighbour = (await blocks.nth(1).boundingBox())!
  expect(Math.round(grown.y + grown.height - laneBox.y)).toBe(Math.round(neighbour.y - laneBox.y))
})

test('a block can be deleted from the block itself', async ({ page }) => {
  await login(page)
  await page.goto('/sessions/1/schedule')
  const lane = page.locator('[data-testid^="placement-"]').first()
  await expect(lane.locator('[data-testid^="block-"]')).toHaveCount(2)

  await openEditTools(page)
  const saved = saveOf(page)
  await lane.locator('[data-testid^="block-"]').last().hover()
  await lane.getByRole('button', { name: /^delete / }).last().click()
  await saved

  await page.reload()
  await expect(lane.locator('[data-testid^="block-"]')).toHaveCount(1)
})

test('erase clears a span', async ({ page }) => {
  await login(page)
  await page.goto('/sessions/1/schedule')
  const lane = page.locator('[data-testid^="placement-"]').first()
  await expect(lane.locator('[data-testid^="block-"]')).toHaveCount(1)

  await openEditTools(page)
  await page.getByRole('button', { name: 'erase' }).click()
  await dragRows(page, lane, 0, 12)

  await page.reload()
  await expect(lane.locator('[data-testid^="block-"]')).toHaveCount(0)
})

test('generate, mark the coach absent, repair with a summary', async ({ page }) => {
  page.on('dialog', (d) => void d.accept())
  await login(page)

  // Give the class its coach so generated blocks are staffed.
  await page.goto('/classes')
  // Level 3 Girls is the first class. The row being edited is the one with a
  // Cancel button — its name lives in an input's value, which hasText can't
  // see.
  await page.getByRole('button', { name: 'Edit' }).first().click()
  const editRow = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: 'Cancel' }) })
  await editRow.getByRole('button', { name: 'Dana Marsh' }).click()
  await editRow.getByRole('button', { name: 'Save' }).click()

  await page.goto('/sessions/1/schedule')
  await page.getByRole('button', { name: 'Generate schedule' }).click()
  // A generated block, staffed — not the coach's chip in the day-of panel.
  await expect(
    page.locator('[data-testid^="block-"]').filter({ hasText: 'Dana Marsh' }).first(),
  ).toBeVisible()

  // Mark Dana out for this session; affected blocks get flagged.
  await page.getByText('Day-of changes').click()
  await page.getByRole('button', { name: 'Dana Marsh', exact: true }).click()
  await expect(page.getByText(/blocks? affected/)).toBeVisible()

  // Repair keeps placements and explains the coach change.
  await page.getByRole('button', { name: 'Repair schedule' }).click()
  await expect(page.getByText('Schedule repaired')).toBeVisible()
  // Both classes are hers, so both are named.
  await expect(page.getByText(/Dana Marsh is out/).first()).toBeVisible()
  await expect(page.getByText(/currently has no coach/).first()).toBeVisible()
})

test('print view renders lanes, class windows, and per-class strips', async ({ page }) => {
  await login(page)
  await page.goto('/sessions/1/print')
  await expect(page.getByRole('heading', { name: 'Monday Practice' })).toBeVisible()
  // The header names the specific date, not just a weekday.
  await expect(page.getByText(/Monday, March 2, 2026/)).toBeVisible()
  // A lane header names the classes it runs, in order.
  await expect(page.getByRole('columnheader', { name: 'LV 1 → LV 2' })).toBeVisible()
  await expect(page.getByText('Where do I go next?')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Print this page' })).toBeVisible()
})

test('copy session carries the schedule to next week, defaulting a week out', async ({ page }) => {
  await login(page)
  await page.goto('/sessions/1/schedule')
  await page.getByRole('button', { name: 'Copy session' }).click()

  // The weekly workflow: default the copy to the same weekday, one week on.
  await expect(page.getByLabel('New date')).toHaveValue('2026-03-09')
  await expect(page.getByText('Monday, March 9, 2026')).toBeVisible()
  await page.getByRole('button', { name: 'Create copy' }).click()

  // Lands on the copy — a different session id, on the new date.
  await expect(page).toHaveURL(/\/sessions\/(?!1\/)\d+\/schedule$/)
  await expect(page.getByText(/Monday, March 9, 2026/)).toBeVisible()
  // The grid came along: same lanes, same class windows.
  await expect(page.getByText('LV 1 16:00–17:00')).toBeVisible()
  await expect(page.getByText('LV 2 17:00–18:00')).toBeVisible()
})

test('sessions list shows dates chronologically and copies from there too', async ({ page }) => {
  await login(page)
  await page.goto('/sessions')

  // Both practices are listed, earliest first.
  const dates = page.locator('li p')
  await expect(dates.first()).toContainText('Monday, March 2, 2026')
  await expect(dates.nth(1)).toContainText('Monday, March 9, 2026')

  // Copy is available straight from the list — the weekly workflow.
  await page.getByRole('button', { name: 'Copy' }).first().click()
  await page.getByLabel('New date').fill('2026-03-16')
  await page.getByRole('button', { name: 'Create copy' }).click()
  await expect(page).toHaveURL(/\/sessions\/\d+\/schedule$/)
  await expect(page.getByText(/Monday, March 16, 2026/)).toBeVisible()
})

test('dark mode toggles from the header, persists, and spares the print view', async ({
  page,
}) => {
  await login(page)

  const WHITE = 'rgb(255, 255, 255)'
  const html = page.locator('html')
  // Cards are white in light mode — a stand-in for "the app repainted".
  const card = page.locator('div.rounded-xl.bg-white').first()

  // Starts light: no saved choice, and headless Chromium reports light.
  await expect(html).not.toHaveClass(/dark/)
  await expect(card).toHaveCSS('background-color', WHITE)

  // The sun shows in light mode; the label says where a click takes you.
  await page.getByRole('button', { name: 'Switch to dark mode' }).click()

  // Dark now: class set, native color-scheme flipped, surfaces repainted,
  // and the button became the half moon.
  await expect(html).toHaveClass(/dark/)
  await expect(html).toHaveCSS('color-scheme', 'dark')
  await expect(card).not.toHaveCSS('background-color', WHITE)
  await expect(page.getByRole('button', { name: 'Switch to light mode' })).toBeVisible()

  // The choice survives a reload (applied before first paint, so no flash).
  await page.reload()
  await expect(html).toHaveClass(/dark/)
  await expect(page.getByRole('button', { name: 'Switch to light mode' })).toBeVisible()

  // The print sheet stays black-on-white paper even while dark mode is on.
  await page.goto('/sessions/1/print')
  await expect(html).toHaveClass(/dark/)
  await expect(page.locator('div.bg-white').first()).toHaveCSS('background-color', WHITE)
  await expect(page.getByRole('heading', { name: 'Monday Practice' })).toBeVisible()

  // Back to light, and that sticks too.
  await page.goto('/')
  await page.getByRole('button', { name: 'Switch to light mode' }).click()
  await page.reload()
  await expect(html).not.toHaveClass(/dark/)
  await expect(page.getByRole('button', { name: 'Switch to dark mode' })).toBeVisible()
})
