import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// One serial journey against a single fresh database: first-run wizard,
// then generation + day-of repair, the print view, session copying, and
// the dark mode toggle.
test.describe.configure({ mode: 'serial' })

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill('e2e-password-1')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('link', { name: 'Home' })).toBeVisible()
}

// First-run smoke test: create the admin account, then walk the guided
// setup wizard end to end and land on the new session's schedule grid.
test('first run: admin setup, then the setup wizard through to the grid', async ({ page }) => {
  await page.goto('/')

  // Fresh database → admin account creation.
  await expect(page).toHaveURL(/\/setup$/)
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel(/^Password/).fill('e2e-password-1')
  await page.getByLabel('Confirm password').fill('e2e-password-1')
  await page.getByRole('button', { name: 'Create admin account' }).click()

  // Home shows the guide; start the wizard.
  await expect(page.getByText('Welcome to Salto')).toBeVisible()
  await page.getByRole('link', { name: 'Start setup' }).click()
  await expect(page).toHaveURL(/\/guide\/events$/)
  await expect(page.getByText('Step 1 of 4')).toBeVisible()

  // Step 1 — events. Next is gated on having at least one.
  await expect(page.getByRole('button', { name: /next/i })).toBeDisabled()
  await page.getByLabel('Event name').fill('Vault')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Vault')).toBeVisible()
  await expect(page.getByRole('button', { name: /next/i })).toBeEnabled()
  await page.getByRole('button', { name: /next/i }).click()

  // Step 2 — classes, with a required event (Vault, 30 min default).
  await expect(page).toHaveURL(/\/guide\/classes$/)
  await expect(page.getByText('Step 2 of 4')).toBeVisible()
  await page.getByLabel('Class name').fill('Level 3 Girls')
  await page.getByRole('button', { name: '+ Add event' }).click()
  // The fit summary tracks the draft requirements live.
  await expect(page.getByText('Total required: 30 min')).toBeVisible()
  await page.getByLabel('duration in minutes').fill('45')
  await expect(page.getByText('Total required: 45 min')).toBeVisible()
  await page.getByLabel('duration in minutes').fill('30')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: /next/i })).toBeEnabled()
  await page.getByRole('button', { name: /next/i }).click()

  // Step 3 — coaches. Exercise Back and return.
  await expect(page.getByText('Step 3 of 4')).toBeVisible()
  await page.getByRole('button', { name: /back/i }).click()
  await expect(page).toHaveURL(/\/guide\/classes$/)
  await expect(page.getByText('Level 3 Girls', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /next/i }).click()
  await page.getByLabel('Coach name').fill('Dana Marsh')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: /next/i })).toBeEnabled()
  await page.getByRole('button', { name: /next/i }).click()

  // Step 4 — first session on a specific date. Classes come pre-selected;
  // Finish is gated.
  await expect(page).toHaveURL(/\/guide\/session$/)
  await expect(page.getByText('Step 4 of 4')).toBeVisible()
  await expect(page.getByRole('button', { name: /finish/i })).toBeDisabled()
  await page.getByLabel(/session name/i).fill('Monday Practice')
  await page.getByLabel('Date').fill('2026-03-02')
  await expect(page.getByText('Monday, March 2, 2026')).toBeVisible()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: /finish/i })).toBeEnabled()
  await page.getByRole('button', { name: /finish/i }).click()

  // Finish lands on the new session's schedule grid with the pointer.
  await expect(page).toHaveURL(/\/sessions\/\d+\/schedule\?welcome=1$/)
  await expect(page.getByText('Setup complete')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Generate schedule' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Monday Practice' })).toBeVisible()

  // The pointer dismisses.
  await page.getByRole('button', { name: 'Got it' }).click()
  await expect(page.getByText('Setup complete')).not.toBeVisible()

  // Home no longer shows the guide once setup is complete.
  await page.getByRole('link', { name: 'Home' }).click()
  await expect(page.getByText('Your sessions')).toBeVisible()
  await expect(page.getByText('Welcome to Salto')).not.toBeVisible()
})

test('generate, mark the coach absent, repair with a summary', async ({ page }) => {
  await login(page)

  // Give the class its coach so generated cells are staffed.
  await page.goto('/classes')
  await page.getByRole('button', { name: 'Edit' }).click()
  const editRow = page.getByRole('listitem')
  await editRow.getByRole('button', { name: 'Dana Marsh' }).click()
  await editRow.getByRole('button', { name: 'Save' }).click()

  await page.goto('/')
  await page.getByRole('link', { name: /Monday Practice/ }).click()
  await page.getByRole('button', { name: 'Generate schedule' }).click()
  await expect(page.getByRole('cell', { name: /Dana Marsh/ }).first()).toBeVisible()

  // Mark Dana out for this session; affected cells get flagged.
  await page.getByText('Day-of changes').click()
  await page.getByRole('button', { name: 'Dana Marsh', exact: true }).click()
  await expect(page.getByText(/assignments? affected/)).toBeVisible()

  // Repair keeps placements and explains the coach change.
  await page.getByRole('button', { name: 'Repair schedule' }).click()
  await expect(page.getByText('Schedule repaired')).toBeVisible()
  await expect(page.getByText(/Dana Marsh is out/)).toBeVisible()
  await expect(page.getByText(/currently has no coach/)).toBeVisible()
})

test('print view renders the block layout and class strips', async ({ page }) => {
  await login(page)
  await page.goto('/sessions/1/print')
  await expect(page.getByRole('heading', { name: 'Monday Practice' })).toBeVisible()
  // The header names the specific date, not just a weekday.
  await expect(page.getByText(/Monday, March 2, 2026/)).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Level 3 Girls' })).toBeVisible()
  await expect(page.getByText('Where do I go next?')).toBeVisible()
  await expect(page.getByText(/16:00 Vault/)).toBeVisible()
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
  // The copied schedule came along.
  await expect(page.getByText('Level 3 Girls').first()).toBeVisible()
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
