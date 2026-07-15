import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// One serial journey against a single fresh database: first run, the lane
// grid and its editing (place → paint → move → resize → erase), generation +
// day-of repair, the print view, session copying, and the dark mode toggle.
test.describe.configure({ mode: 'serial' })

/** Row height in the grid, in px — must match src/pages/schedule/grid.ts. */
const ROW_H = 20

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill('e2e-password-1')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('link', { name: 'Home' })).toBeVisible()
}

/**
 * Drag inside a class's lane from one row offset to another, in rows from
 * the top of the class's window. This is the product's primary gesture.
 *
 * The write is awaited on the network, not on the "Saved" label: that label
 * reads "Saved" before anything happens, so waiting for it would pass
 * instantly and race the assertion that follows.
 */
async function dragRows(page: Page, placement: ReturnType<Page['locator']>, from: number, to: number) {
  const box = (await placement.boundingBox())!
  const x = box.x + box.width / 2
  // Press in the middle of the row, as a hand does. The top and bottom few
  // pixels of a block are its resize handles, so pressing right on a row
  // boundary would drag the edge instead of painting.
  const y = (row: number) => box.y + row * ROW_H + ROW_H / 2
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && r.url().includes('/schedule'),
  )
  await page.mouse.move(x, y(from))
  await page.mouse.down()
  // Several steps so the drag really tracks, as a hand would.
  const steps = Math.max(Math.abs(to - from), 1)
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x, y(from + ((to - from) * i) / steps))
  }
  await page.mouse.up()
  await saved
}

/**
 * Add a lane and wait for it to actually exist. `expected` is the resulting
 * number of lanes — counting first would race the grid's own first render.
 */
async function addColumn(page: Page, expected: number) {
  await expect(page.getByRole('button', { name: '+ Add class' })).toHaveCount(expected - 1)
  await page.getByRole('button', { name: '+ Add column' }).click()
  await expect(page.getByRole('button', { name: '+ Add class' })).toHaveCount(expected)
}

// First-run smoke test: create the admin account, then walk the guided
// setup wizard end to end and land on the new session's schedule grid.
test('first run: admin account, then set the gym up from the normal pages', async ({ page }) => {
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

  // Events.
  for (const name of ['Vault', 'Beam']) {
    await page.getByLabel('Event name').fill(name)
    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect(page.getByText(name, { exact: true })).toBeVisible()
  }

  // A class, with a required event and the live fit summary.
  await page.getByRole('link', { name: 'Classes' }).click()
  await page.getByLabel('Class name').fill('Level 3 Girls')
  await page.getByRole('button', { name: '+ Add event' }).click()
  await expect(page.getByText('Total required: 30 min')).toBeVisible()
  await page.getByLabel('duration in minutes').fill('45')
  await expect(page.getByText('Total required: 45 min')).toBeVisible()
  await page.getByLabel('duration in minutes').fill('30')
  await page.getByRole('button', { name: 'Save' }).first().click()
  await expect(page.getByText('Level 3 Girls', { exact: true })).toBeVisible()

  // A coach.
  await page.getByRole('link', { name: 'Coaches' }).click()
  await page.getByLabel('Coach name').fill('Dana Marsh')
  await page.getByRole('button', { name: 'Save' }).first().click()
  await expect(page.getByText('Dana Marsh', { exact: true })).toBeVisible()

  // A session on a specific date, seeded with the class.
  await page.getByRole('link', { name: 'Sessions' }).click()
  await page.getByLabel(/session name/i).fill('Monday Practice')
  await page.getByLabel('Date').fill('2026-03-02')
  await expect(page.getByText('Monday, March 2, 2026')).toBeVisible()
  await page.getByRole('button', { name: 'Level 3 Girls' }).click()
  await page.getByRole('button', { name: 'Save' }).first().click()
  await expect(page.getByText(/Monday, March 2, 2026/)).toBeVisible()

  // Home lists it; open its grid.
  await page.getByRole('link', { name: 'Home' }).click()
  await expect(page.getByText('Your sessions')).toBeVisible()
  await page.getByRole('link', { name: /Monday Practice/ }).click()
  await expect(page.getByRole('heading', { name: 'Monday Practice' })).toBeVisible()
  // The class it was created with landed in its own lane, full window.
  await expect(page.getByText('Level 3 Girls 16:00–18:00')).toBeVisible()
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
  await addColumn(page, 2)

  // LV 1 takes the first hour of the new lane…
  await page.getByRole('button', { name: '+ Add class' }).nth(1).click()
  await page.getByRole('combobox', { name: 'Class' }).selectOption({ label: 'LV 1' })
  await page.getByLabel('class starts').fill('16:00')
  await page.getByLabel('class ends').fill('17:00')
  await page.getByRole('button', { name: 'Add class', exact: true }).click()
  await expect(page.getByText('LV 1 16:00–17:00')).toBeVisible()

  // …and LV 2 stacks directly after it in the SAME lane.
  await page.getByRole('button', { name: '+ Add class' }).nth(1).click()
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

  // LV 1 already runs 16:00–17:00 in column 2; try to overlap it.
  await page.getByRole('button', { name: '+ Add class' }).nth(1).click()
  await page.getByRole('combobox', { name: 'Class' }).selectOption({ label: 'Level 3 Girls' })
  await page.getByLabel('class starts').fill('16:30')
  await page.getByLabel('class ends').fill('17:30')
  await page.getByRole('button', { name: 'Add class', exact: true }).click()

  // Refused, and said so — the placement is not created.
  await expect(page.getByText(/column .* holds one class at a time/i)).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByText('Level 3 Girls 16:30–17:30')).not.toBeVisible()
})

test('blank cells show outside a class window, never a forced fill', async ({ page }) => {
  await login(page)
  await page.goto('/sessions/1/schedule')

  // LV 1 runs 16:00–17:00 and LV 2 runs 17:00–18:00, so their lane is
  // covered — but a class placed on a partial window leaves real blanks.
  await addColumn(page, 3)
  await page.getByRole('button', { name: '+ Add class' }).nth(2).click()
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

  // Level 3 Girls runs the whole session in column 1.
  const lane = page.locator('[data-testid^="placement-"]').first()
  await page.getByRole('button', { name: 'paint Beam' }).click()

  // Drag six rows: 30 minutes of Beam, from 16:10.
  await dragRows(page, lane, 2, 8)
  const beam = lane.locator('[data-testid^="block-"]').first()
  await expect(beam).toBeVisible()
  await expect(beam).toContainText('Beam')
  // Six 5-minute rows tall, exactly what was dragged.
  expect(Math.round((await beam.boundingBox())!.height)).toBe(6 * ROW_H)

  // It survives a reload — the drag really wrote.
  await page.reload()
  await expect(page.locator('[data-testid^="block-"]').first()).toContainText('Beam')
})

test('painting over an existing block overwrites the span', async ({ page }) => {
  await login(page)
  await page.goto('/sessions/1/schedule')
  const lane = page.locator('[data-testid^="placement-"]').first()

  // Vault straight over the middle of the Beam block painted above.
  await page.getByRole('button', { name: 'paint Vault' }).click()
  await dragRows(page, lane, 4, 6)

  await page.reload()
  const blocks = lane.locator('[data-testid^="block-"]')
  // Beam split around the new Vault: Beam, Vault, Beam.
  await expect(blocks).toHaveCount(3)
  await expect(blocks.nth(0)).toContainText('Beam')
  await expect(blocks.nth(1)).toContainText('Vault')
  await expect(blocks.nth(2)).toContainText('Beam')
})

test('erase clears a span', async ({ page }) => {
  await login(page)
  await page.goto('/sessions/1/schedule')
  const lane = page.locator('[data-testid^="placement-"]').first()
  // The Beam/Vault/Beam painted above all live in rows 2–8.
  await expect(lane.locator('[data-testid^="block-"]')).toHaveCount(3)

  await page.getByRole('button', { name: 'erase' }).click()
  await dragRows(page, lane, 2, 8)

  await page.reload()
  await expect(lane.locator('[data-testid^="block-"]')).toHaveCount(0)
})

test('generate, mark the coach absent, repair with a summary', async ({ page }) => {
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
  await page.getByRole('button', { name: 'Generate', exact: true }).click()
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
  await expect(page.getByText(/Dana Marsh is out/)).toBeVisible()
  await expect(page.getByText(/currently has no coach/)).toBeVisible()
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
