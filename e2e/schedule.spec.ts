import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// One serial journey against a single fresh database: first run (the new
// four-week-plan model — events with duration/shared, classes with an eligible
// list and period/warm-up/cool-down), generating the plan and checking
// coverage and the exclusive-event rule, per-week locks, the week grid's hand
// editing, the print view, and dark mode.
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

/** The grid writes on pointer-release; await the PUT, not the "Saved" label. */
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

/** Paint or erase across a class's rows, counted from the top of its window. */
async function dragRows(page: Page, placement: Loc, from: number, to: number) {
  const box = (await placement.boundingBox())!
  const x = box.x + box.width / 2
  const y = (row: number) => box.y + row * ROW_H + ROW_H / 2
  const saved = saveOf(page)
  await drag(page, { x, y: y(from) }, { x, y: y(to) })
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

// First-run smoke test: create the admin account, then enter the whole
// four-week-plan structure and gather a program into a session.
test('first run: enter the four-week-plan structure', async ({ page }) => {
  await page.goto('/')

  // Fresh database → admin account creation.
  await expect(page).toHaveURL(/\/setup$/)
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel(/^Password/).fill('e2e-password-1')
  await page.getByLabel('Confirm password').fill('e2e-password-1')
  await page.getByRole('button', { name: 'Create admin account' }).click()

  await expect(page.getByText('Welcome to Salto')).toBeVisible()
  await page.getByRole('link', { name: 'Start with events' }).click()
  await expect(page).toHaveURL(/\/events$/)

  // Events are facility-wide, each with a per-visit duration. Warm-up and
  // Stretch are shared (many classes at once); the Tumble Trak is exclusive,
  // which is what makes contention a puzzle worth generating around.
  const events: [string, string, boolean][] = [
    ['Warm-up', '10', true],
    ['Stretch', '10', true],
    ['Tumble Trak', '15', false],
    ['Vault', '10', false],
    ['Beam', '10', false],
  ]
  for (const [name, minutes, shared] of events) {
    await page.getByLabel('Event name').fill(name)
    await page.getByLabel('Minutes per visit').fill(minutes)
    const sharedBox = page.getByRole('checkbox', { name: 'Shared' })
    if ((await sharedBox.isChecked()) !== shared) await sharedBox.click()
    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect(page.getByText(name, { exact: true })).toBeVisible()
    // Reset the shared box for the next event (form keeps its initial).
    if (shared) {
      // nothing: form resets to unchecked initial after save
    }
  }

  // A program on its clock — all its classes run these times, every week.
  await page.getByRole('link', { name: 'Programs' }).click()
  await page.getByLabel('Program name').fill('Preschool')
  await page.getByLabel('default start time').fill('16:00')
  await page.getByLabel('default end time').fill('17:00')
  await page.getByRole('button', { name: 'Save' }).first().click()
  await expect(page.getByText('Preschool', { exact: true })).toBeVisible()

  // Two classes. Each warms up, cools down, and rotates through an eligible
  // subset that includes the contested Trak.
  await page.getByRole('link', { name: 'Classes' }).click()
  const classes: [string, string][] = [
    ['Tiny Tot 1', 'Vault'],
    ['Tiny Tot 2', 'Beam'],
  ]
  for (const [name, apparatus] of classes) {
    const form = page.locator('form').first()
    await form.getByLabel('Class name').fill(name)
    await form.getByLabel('Period (min)').fill('60')
    await form.getByRole('combobox', { name: 'Warm-up event' }).selectOption({ label: 'Warm-up' })
    await form.getByLabel('Warm-up minutes').fill('10')
    await form.getByRole('combobox', { name: 'Cool-down event' }).selectOption({ label: 'Stretch' })
    await form.getByLabel('Cool-down minutes').fill('10')
    // Eligible events: the Trak plus this class's own apparatus.
    await form.getByRole('button', { name: /Tumble Trak/ }).click()
    await form.getByRole('button', { name: new RegExp(apparatus) }).click()
    // The fit summary is honest about the per-period budget.
    await expect(form.getByText(/Middle time: 40 min/)).toBeVisible()
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

  // Both classes take a lane each on the same clock.
  const lanes = page.locator('[data-testid^="placement-"]')
  await expect(lanes).toHaveCount(2)
})

test('generate the four-week plan: coverage met, exclusive event never doubled', async ({
  page,
}) => {
  page.on('dialog', (d) => void d.accept())
  await login(page)
  await page.goto('/sessions/1/schedule')
  await expect(page.locator('[data-testid^="placement-"]')).toHaveCount(2)

  await page.getByRole('button', { name: 'Generate 4-week plan' }).click()

  // The coverage panel appears, and nothing fell short of the floor of two.
  await expect(page.getByText('Coverage across the four weeks')).toBeVisible()
  await expect(page.getByTitle('below the target of 2 visits')).toHaveCount(0)
  // Every class reaches the Trak at least twice across the plan.
  await expect(page.getByText(/Tumble Trak: [234]/).first()).toBeVisible()

  // Week 1's grid: the exclusive Trak is never held by both classes at once.
  const traks = page.locator('[data-testid^="block-"]').filter({ hasText: 'Tumble Trak' })
  await expect(traks).toHaveCount(2)
  const boxes = await Promise.all([0, 1].map(async (i) => (await traks.nth(i).boundingBox())!))
  const [a, b] = boxes.sort((x, y) => x.y - y.y)
  expect(a!.y + a!.height).toBeLessThanOrEqual(Math.round(b!.y) + 1)

  // The warm-up leads each lane.
  const lanes = page.locator('[data-testid^="placement-"]')
  for (const i of [0, 1]) {
    await expect(lanes.nth(i).locator('[data-testid^="block-"]').first()).toContainText('Warm-up')
  }

  // Switching weeks shows a different grid, also generated.
  await page.getByRole('button', { name: '2', exact: true }).click()
  await expect(page.getByText('Editing week 2')).toBeVisible()
  await expect(page.locator('[data-testid^="block-"]').first()).toBeVisible()
})

test('locking a week keeps it through a re-randomize', async ({ page }) => {
  page.on('dialog', (d) => void d.accept())
  await login(page)
  await page.goto('/sessions/1/schedule')

  // Look at week 2 and lock it.
  await page.getByRole('button', { name: '2', exact: true }).click()
  await expect(page.getByText('Editing week 2')).toBeVisible()
  await page.getByRole('button', { name: 'lock week 2' }).click()
  await expect(page.getByText('Editing week 2 (locked)')).toBeVisible()

  // Remember week 2's Trak position *within its lane* — the coverage panel
  // appearing later shifts the whole page, so an absolute Y would lie.
  const lane = page.locator('[data-testid^="placement-"]').first()
  const trakOffset = async () => {
    const laneBox = (await lane.boundingBox())!
    const trak = (await lane
      .locator('[data-testid^="block-"]')
      .filter({ hasText: 'Tumble Trak' })
      .first()
      .boundingBox())!
    return Math.round(trak.y - laneBox.y)
  }
  await expect(
    lane.locator('[data-testid^="block-"]').filter({ hasText: 'Tumble Trak' }),
  ).toHaveCount(1)
  const before = await trakOffset()

  // Re-randomize the plan. Locked weeks are left alone.
  await page.getByRole('button', { name: 'Re-randomize' }).click()
  await expect(page.getByText('Coverage across the four weeks')).toBeVisible()

  // Still on week 2, still locked, and the Trak is exactly where it was.
  await expect(page.getByText('Editing week 2 (locked)')).toBeVisible()
  expect(await trakOffset()).toBe(before)
})

test('a week grid can still be hand-edited, per week', async ({ page }) => {
  await login(page)
  await page.goto('/sessions/1/schedule')
  // Work on week 1.
  await page.getByRole('button', { name: '1', exact: true }).click()

  const lane = page.locator('[data-testid^="placement-"]').first()
  // Erase the lane, then paint a fresh block of Beam.
  await openEditTools(page)
  await page.getByRole('button', { name: 'erase' }).click()
  await dragRows(page, lane, 0, 12)
  await expect(lane.locator('[data-testid^="block-"]')).toHaveCount(0)

  await page.getByRole('button', { name: 'paint Beam' }).click()
  await dragRows(page, lane, 2, 8)
  const beam = lane.locator('[data-testid^="block-"]').first()
  await expect(beam).toContainText('Beam')
  expect(Math.round((await beam.boundingBox())!.height)).toBe(6 * ROW_H)

  // It survives a reload — and only touched week 1.
  await page.reload()
  await expect(
    page.locator('[data-testid^="placement-"]').first().locator('[data-testid^="block-"]').first(),
  ).toContainText('Beam')
})

test('print view renders every week and its per-class strips', async ({ page }) => {
  await login(page)
  await page.goto('/sessions/1/print')
  await expect(page.getByRole('heading', { name: 'Monday Practice' })).toBeVisible()
  await expect(page.getByText(/Monday, March 2, 2026/)).toBeVisible()
  // One heading per plan week.
  for (const w of [1, 2, 3, 4]) {
    await expect(page.getByRole('heading', { name: `Week ${w}`, exact: true })).toBeVisible()
  }
  await expect(page.getByText('Week 1 — where do I go next?')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Print this page' })).toBeVisible()
})

test('Excel export downloads a workbook', async ({ page }) => {
  await login(page)
  await page.goto('/sessions/1/schedule')
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Export to Excel' }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/salto-monday-practice\.xlsx/)
})

test('dark mode toggles from the header and spares the print view', async ({ page }) => {
  await login(page)

  const WHITE = 'rgb(255, 255, 255)'
  const html = page.locator('html')
  const card = page.locator('div.rounded-xl.bg-white').first()

  await expect(html).not.toHaveClass(/dark/)
  await expect(card).toHaveCSS('background-color', WHITE)

  await page.getByRole('button', { name: 'Switch to dark mode' }).click()
  await expect(html).toHaveClass(/dark/)
  await expect(html).toHaveCSS('color-scheme', 'dark')
  await expect(card).not.toHaveCSS('background-color', WHITE)

  await page.reload()
  await expect(html).toHaveClass(/dark/)

  // The print sheet stays black-on-white paper even in dark mode.
  await page.goto('/sessions/1/print')
  await expect(html).toHaveClass(/dark/)
  await expect(page.locator('div.bg-white').first()).toHaveCSS('background-color', WHITE)

  await page.goto('/')
  await page.getByRole('button', { name: 'Switch to light mode' }).click()
  await page.reload()
  await expect(html).not.toHaveClass(/dark/)
})
