import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// One serial journey against a single fresh database: first run with the
// class-owns-schedule model (events with duration/shared; classes with a day,
// start time, eligible list and warm-up/cool-down), the ordered-setup helper,
// sessions auto-grouping from the classes, generating a slot's repeating
// 4-week plan and checking coverage and the exclusive-event rule, per-week
// locks, the week grid's hand editing, the print view, and dark mode.
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

/** The hand-editing tools sit behind a disclosure; open it first. */
async function openEditTools(page: Page) {
  if (await page.getByRole('button', { name: 'erase' }).isHidden()) {
    await page.getByText('Edit by hand').click()
  }
  await expect(page.getByRole('button', { name: 'erase' })).toBeVisible()
}

/** Fill a class form (the top "Add class" form) and save it. */
async function addClass(
  page: Page,
  opts: {
    name: string
    day: string
    start: string
    period: string
    warmup: string
    cooldown: string
    /** [event name, minutes this class spends there]. */
    eligible: [string, string][]
    copyFrom?: string
  },
) {
  const form = page.locator('form').first()
  await form.getByLabel('Class name').fill(opts.name)
  if (opts.copyFrom) {
    await form.getByRole('combobox', { name: 'copy setup from' }).selectOption({ label: opts.copyFrom })
  } else {
    await form.getByLabel('Period (min)').fill(opts.period)
    await form.getByRole('button', { name: opts.day }).click()
    await form.getByLabel('start time').fill(opts.start)
    await form.getByRole('combobox', { name: 'Warm-up event' }).selectOption({ label: opts.warmup })
    await form.getByLabel('Warm-up minutes').fill('10')
    await form.getByRole('combobox', { name: 'Cool-down event' }).selectOption({ label: opts.cooldown })
    await form.getByLabel('Cool-down minutes').fill('10')
    // Each eligible event is added from the dropdown, then given its minutes.
    for (const [ev, minutes] of opts.eligible) {
      await form.getByRole('combobox', { name: 'add eligible event' }).selectOption({ label: ev })
      await form.getByLabel(`${ev} minutes`).fill(minutes)
    }
  }
  await form.getByRole('button', { name: 'Save' }).click()
  // Confirm it landed in the class list (not just the copy-setup dropdown).
  await expect(page.locator('li').filter({ hasText: opts.name }).first()).toBeVisible()
}

// First-run smoke test: create the admin account, then enter the whole
// structure and watch the sessions group themselves.
test('first run: enter the class-owned structure, sessions auto-group', async ({ page }) => {
  await page.goto('/')

  await expect(page).toHaveURL(/\/setup$/)
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel(/^Password/).fill('e2e-password-1')
  await page.getByLabel('Confirm password').fill('e2e-password-1')
  await page.getByRole('button', { name: 'Create admin account' }).click()

  await expect(page.getByText('Welcome to Salto')).toBeVisible()
  await page.getByRole('link', { name: 'Start with events' }).click()
  await expect(page).toHaveURL(/\/events$/)

  // The ordered-setup helper guides the build order but leaves the nav free.
  await expect(page.getByText('Getting set up')).toBeVisible()

  // Events carry no duration now — just a name and the shared/exclusive tag.
  const events: [string, boolean][] = [
    ['Warm-up', true],
    ['Stretch', true],
    ['Tumble Trak', false],
    ['Vault', false],
    ['Beam', false],
  ]
  for (const [name, shared] of events) {
    await page.getByLabel('Event name').fill(name)
    const sharedBox = page.getByRole('checkbox', { name: 'Shared' })
    if ((await sharedBox.isChecked()) !== shared) await sharedBox.click()
    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect(page.getByText(name, { exact: true })).toBeVisible()
  }

  // Step 2: a program.
  await page.getByRole('link', { name: 'Programs', exact: true }).click()
  await page.getByLabel('Program name').fill('Preschool')
  await page.getByRole('button', { name: 'Save' }).first().click()
  await expect(page.getByText('Preschool', { exact: true })).toBeVisible()

  // Step 3: classes that own their schedule — both meet Monday at 16:00, so
  // they will form one "Monday 4:00 PM" slot. The second copies the first.
  await page.getByRole('link', { name: 'Classes', exact: true }).click()
  await addClass(page, {
    name: 'Tiny Tot 1',
    day: 'Monday',
    start: '16:00',
    period: '60',
    warmup: 'Warm-up',
    cooldown: 'Stretch',
    eligible: [
      ['Tumble Trak', '15'],
      ['Vault', '10'],
    ],
  })
  await addClass(page, {
    name: 'Tiny Tot 2',
    day: '',
    start: '',
    period: '',
    warmup: '',
    cooldown: '',
    eligible: [],
    copyFrom: 'Tiny Tot 1',
  })

  // A coach.
  await page.getByRole('link', { name: 'Coaches', exact: true }).click()
  await page.getByLabel('Coach name').fill('Dana Marsh')
  await page.getByRole('button', { name: 'Save' }).first().click()
  await expect(page.getByText('Dana Marsh', { exact: true })).toBeVisible()

  // Step 4: sessions grouped themselves from the classes' schedules.
  await page.getByRole('link', { name: 'Sessions', exact: true }).click()
  await expect(page.getByText('Monday 4:00 PM')).toBeVisible()
  await expect(page.getByText(/2 classes · repeating 4-week plan/)).toBeVisible()
})

test('generate a slot plan: coverage met, exclusive event never doubled', async ({ page }) => {
  page.on('dialog', (d) => void d.accept())
  await login(page)
  await page.goto('/sessions')
  await page.getByRole('link', { name: 'Generate / view plan' }).first().click()
  await expect(page).toHaveURL(/\/sessions\/\d+\/schedule$/)

  // Both classes are already in the slot — no gather step.
  await expect(page.locator('[data-testid^="placement-"]')).toHaveCount(2)

  await page.getByRole('button', { name: 'Generate 4-week plan' }).click()
  await expect(page.getByText('Coverage across the four weeks')).toBeVisible()
  await expect(page.getByTitle('below the target of 2 visits')).toHaveCount(0)
  await expect(page.getByText(/Tumble Trak: [234]/).first()).toBeVisible()

  // Week 1: the exclusive Trak is never held by both classes at once.
  const traks = page.locator('[data-testid^="block-"]').filter({ hasText: 'Tumble Trak' })
  await expect(traks).toHaveCount(2)
  const boxes = await Promise.all([0, 1].map(async (i) => (await traks.nth(i).boundingBox())!))
  const [a, b] = boxes.sort((x, y) => x.y - y.y)
  expect(a!.y + a!.height).toBeLessThanOrEqual(Math.round(b!.y) + 1)

  // Warm-up leads each lane.
  const lanes = page.locator('[data-testid^="placement-"]')
  for (const i of [0, 1]) {
    await expect(lanes.nth(i).locator('[data-testid^="block-"]').first()).toContainText('Warm-up')
  }

  await page.getByRole('button', { name: '2', exact: true }).click()
  await expect(page.getByText('Editing week 2')).toBeVisible()
  await expect(page.locator('[data-testid^="block-"]').first()).toBeVisible()
})

test('two classes share an event at different durations, and the plan honors each', async ({
  page,
}) => {
  page.on('dialog', (d) => void d.accept())
  await login(page)

  // Give Tiny Tot 2 a longer Tumble Trak than Tiny Tot 1 — duration lives on
  // the class-event pairing, so the same apparatus differs per class.
  await page.goto('/classes')
  const row = page.getByRole('listitem').filter({ hasText: 'Tiny Tot 2' })
  await row.getByRole('button', { name: 'Edit' }).click()
  const editForm = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: 'Cancel' }) })
  await editForm.getByLabel('Tumble Trak minutes').fill('20')
  await editForm.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Tumble Trak 20′/)).toBeVisible()

  // Generate the slot and read back the two Trak blocks in week 1.
  await page.goto('/sessions')
  await page.getByRole('link', { name: 'Generate / view plan' }).first().click()
  await page.getByRole('button', { name: 'Generate 4-week plan' }).click()
  await expect(page.getByText('Coverage across the four weeks')).toBeVisible()

  const traks = page.locator('[data-testid^="block-"]').filter({ hasText: 'Tumble Trak' })
  await expect(traks).toHaveCount(2)
  const heights = (
    await Promise.all([0, 1].map(async (i) => Math.round((await traks.nth(i).boundingBox())!.height)))
  ).sort((a, b) => a - b)
  // 15 min → 3 rows, 20 min → 4 rows: each class's own duration is honored.
  expect(heights).toEqual([3 * ROW_H, 4 * ROW_H])
})

test('locking a week keeps it through a re-randomize', async ({ page }) => {
  page.on('dialog', (d) => void d.accept())
  await login(page)
  await page.goto('/sessions')
  await page.getByRole('link', { name: 'Generate / view plan' }).first().click()

  await page.getByRole('button', { name: '2', exact: true }).click()
  await expect(page.getByText('Editing week 2')).toBeVisible()
  await page.getByRole('button', { name: 'lock week 2' }).click()
  await expect(page.getByText('Editing week 2 (locked)')).toBeVisible()

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

  await page.getByRole('button', { name: 'Re-randomize' }).click()
  await expect(page.getByText('Coverage across the four weeks')).toBeVisible()

  await expect(page.getByText('Editing week 2 (locked)')).toBeVisible()
  expect(await trakOffset()).toBe(before)
})

test('a week grid can still be hand-edited', async ({ page }) => {
  await login(page)
  await page.goto('/sessions')
  await page.getByRole('link', { name: 'Generate / view plan' }).first().click()
  await page.getByRole('button', { name: '1', exact: true }).click()

  const lane = page.locator('[data-testid^="placement-"]').first()
  await openEditTools(page)
  await page.getByRole('button', { name: 'erase' }).click()
  await dragRows(page, lane, 0, 12)
  await expect(lane.locator('[data-testid^="block-"]')).toHaveCount(0)

  await page.getByRole('button', { name: 'paint Beam' }).click()
  await dragRows(page, lane, 2, 8)
  const beam = lane.locator('[data-testid^="block-"]').first()
  await expect(beam).toContainText('Beam')
  expect(Math.round((await beam.boundingBox())!.height)).toBe(6 * ROW_H)

  await page.reload()
  await expect(
    page.locator('[data-testid^="placement-"]').first().locator('[data-testid^="block-"]').first(),
  ).toContainText('Beam')
})

test('print view renders every week and its per-class strips', async ({ page }) => {
  await login(page)
  await page.goto('/sessions')
  await page.getByRole('link', { name: 'Generate / view plan' }).first().click()
  const url = new URL(page.url())
  await page.goto(url.pathname.replace('/schedule', '/print'))

  await expect(page.getByRole('heading', { name: 'Monday 4:00 PM' })).toBeVisible()
  for (const w of [1, 2, 3, 4]) {
    await expect(page.getByRole('heading', { name: `Week ${w}`, exact: true })).toBeVisible()
  }
  await expect(page.getByText('Week 1 — where do I go next?')).toBeVisible()
})

test('Excel export downloads a workbook', async ({ page }) => {
  await login(page)
  await page.goto('/sessions')
  await page.getByRole('link', { name: 'Generate / view plan' }).first().click()
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Export to Excel' }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/salto-monday-4-00-pm\.xlsx/)
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

  await page.goto('/sessions')
  await page.getByRole('link', { name: 'Generate / view plan' }).first().click()
  const url = new URL(page.url())
  await page.goto(url.pathname.replace('/schedule', '/print'))
  await expect(html).toHaveClass(/dark/)
  await expect(page.locator('div.bg-white').first()).toHaveCSS('background-color', WHITE)

  await page.goto('/')
  await page.getByRole('button', { name: 'Switch to light mode' }).click()
  await page.reload()
  await expect(html).not.toHaveClass(/dark/)
})
