/**
 * tests/e2e/navigation.spec.ts
 * Navigation & layout E2E tests (authenticated Chrome project).
 *
 * Covers:
 *  - Sidebar renders with expected links
 *  - Skip-nav link is focusable  
 *  - Each primary nav link navigates to the correct page
 *  - Topbar user menu opens and shows user email
 *  - Locale switcher is visible
 */
import { test, expect } from '@playwright/test'

test.describe('Navigation & layout (authenticated)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/dashboard/)
  })

  test('sidebar renders all primary nav links', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Main navigation' })
    await expect(nav).toBeVisible()

    // Primary nav items
    for (const label of ['Dashboard', 'Runs', 'Projects', 'Marketplace']) {
      await expect(nav.getByRole('link', { name: label })).toBeVisible()
    }
  })

  test('skip-nav link is focusable and present in DOM', async ({ page }) => {
    const skipLink = page.getByRole('link', { name: /skip to main content/i })
    await expect(skipLink).toBeAttached()
    // Tab to it
    await page.keyboard.press('Tab')
    await expect(skipLink).toBeFocused()
  })

  test('navigating to /projects via sidebar', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Main navigation' })
    await nav.getByRole('link', { name: 'Projects' }).click()
    await page.waitForURL('**/projects', { timeout: 10_000 })
    await expect(page).toHaveURL(/\/projects/)
  })

  test('navigating to /marketplace via sidebar', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Main navigation' })
    await nav.getByRole('link', { name: 'Marketplace' }).click()
    await page.waitForURL('**/marketplace', { timeout: 10_000 })
    await expect(page).toHaveURL(/\/marketplace/)
  })

  test('navigating to /runs via sidebar', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Main navigation' })
    await nav.getByRole('link', { name: 'Runs' }).click()
    await page.waitForURL('**/runs', { timeout: 10_000 })
    await expect(page).toHaveURL(/\/runs/)
  })

  test('topbar user menu opens with email shown', async ({ page }) => {
    // Click user menu button
    const userMenuButton = page.locator('[aria-controls="user-menu"]')
    await expect(userMenuButton).toBeVisible()
    await userMenuButton.click()

    // Dropdown appears
    await expect(page.locator('#user-menu')).toBeVisible()

    // Should show the admin email
    await expect(page.locator('#user-menu')).toContainText('admin@harmoven.local')

    // Profile and Settings items visible
    await expect(page.getByRole('menuitem', { name: /Profile/i })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /Settings/i })).toBeVisible()
  })

  test('topbar user menu closes on Escape', async ({ page }) => {
    const userMenuButton = page.locator('[aria-controls="user-menu"]')
    await userMenuButton.click()
    await expect(page.locator('#user-menu')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.locator('#user-menu')).not.toBeVisible()

    // Focus returns to the trigger button
    await expect(userMenuButton).toBeFocused()
  })

  test('locale switcher is visible in topbar', async ({ page }) => {
    // LocaleSwitcher should render in the topbar
    const header = page.locator('header')
    await expect(header).toBeVisible()
    // It renders a select or button for locale switching
    // Check the header region contains some locale-related control
    await expect(
      header.locator('select, [aria-label*="locale"], [aria-label*="language"]').or(
        header.getByRole('combobox')
      )
    ).toBeAttached()
  })

  test('sidebar collapse button toggles width', async ({ page }) => {
    const sidebar = page.locator('aside')
    const collapseBtn = sidebar.getByRole('button', { name: /collapse sidebar/i })
    await expect(collapseBtn).toBeVisible()

    // Collapse
    await collapseBtn.click()
    await expect(sidebar.getByRole('button', { name: /expand sidebar/i })).toBeVisible()

    // Expand again
    await sidebar.getByRole('button', { name: /expand sidebar/i }).click()
    await expect(collapseBtn).toBeVisible()
  })
})
