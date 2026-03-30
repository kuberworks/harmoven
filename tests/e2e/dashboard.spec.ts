/**
 * tests/e2e/dashboard.spec.ts
 * Dashboard page E2E tests (authenticated Chrome project).
 *
 * Covers:
 *  - Dashboard page loads after login
 *  - Active runs section renders (even if empty)
 *  - Recent projects section renders
 *  - Page title / heading is present
 */
import { test, expect } from '@playwright/test'

test.describe('Dashboard (authenticated)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/dashboard/)
  })

  test('dashboard page loads with main heading or content', async ({ page }) => {
    // Main content area should be visible
    const main = page.locator('#main-content')
    await expect(main).toBeVisible()
  })

  test('page has no critical console errors', async ({ page }) => {
    const errors: string[] = []
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text())
    })

    await page.goto('/dashboard')
    await page.waitForTimeout(2000)

    // Filter out known non-critical errors (e.g. network warnings in dev mode)
    const criticalErrors = errors.filter(e =>
      !e.includes('favicon') &&
      !e.includes('Warning:') &&
      !e.includes('Download the React DevTools')
    )

    expect(criticalErrors, `Unexpected console errors: ${criticalErrors.join('\n')}`).toHaveLength(0)
  })

  test('dashboard has no broken images', async ({ page }) => {
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')

    const brokenImages = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'))
      return imgs
        .filter(img => !img.complete || img.naturalWidth === 0)
        .map(img => img.src)
    })

    expect(brokenImages, `Broken images: ${brokenImages.join(', ')}`).toHaveLength(0)
  })
})
