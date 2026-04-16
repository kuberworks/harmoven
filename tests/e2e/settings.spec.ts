/**
 * tests/e2e/settings.spec.ts
 * Settings page E2E tests (authenticated Chrome project).
 *
 * Covers:
 *  - /settings page loads
 *  - Settings nav items are present (Profile, etc.)
 *  - /settings/profile page renders the profile form
 */
import { test, expect } from '@playwright/test'

test.describe('Settings (authenticated)', () => {
  test('settings page loads', async ({ page }) => {
    await page.goto('/settings')
    await expect(page).toHaveURL(/\/settings/)

    const main = page.locator('#main-content')
    await expect(main).toBeVisible()
  })

  test('profile page loads and shows user email', async ({ page }) => {
    await page.goto('/settings/profile')
    await expect(page).toHaveURL(/\/settings\/profile/)

    // Profile page should show the admin email somehow
    await expect(page.getByText('admin@harmoven.local')).toBeVisible({ timeout: 8_000 })
  })
})
