import { expect, test } from '@playwright/test'

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

  // Step 2 — groups.
  await expect(page).toHaveURL(/\/guide\/groups$/)
  await expect(page.getByText('Step 2 of 4')).toBeVisible()
  await page.getByLabel('Group name').fill('Level 3 Girls')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: /next/i })).toBeEnabled()
  await page.getByRole('button', { name: /next/i }).click()

  // Step 3 — coaches. Exercise Back and return.
  await expect(page.getByText('Step 3 of 4')).toBeVisible()
  await page.getByRole('button', { name: /back/i }).click()
  await expect(page).toHaveURL(/\/guide\/groups$/)
  await expect(page.getByText('Level 3 Girls', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /next/i }).click()
  await page.getByLabel('Coach name').fill('Dana Marsh')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: /next/i })).toBeEnabled()
  await page.getByRole('button', { name: /next/i }).click()

  // Step 4 — first session. Groups come pre-selected; Finish is gated.
  await expect(page).toHaveURL(/\/guide\/session$/)
  await expect(page.getByText('Step 4 of 4')).toBeVisible()
  await expect(page.getByRole('button', { name: /finish/i })).toBeDisabled()
  await page.getByLabel(/session name/i).fill('Monday Practice')
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
