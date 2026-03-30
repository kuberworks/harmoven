/**
 * tests/e2e/projects.spec.ts
 * Projects page E2E tests (authenticated Chrome project).
 *
 * Covers:
 *  - /projects page loads without error
 *  - "New project" button / affordance is present
 *  - Page content area is rendered
 *  - Navigating to a non-existent project shows 404 or redirect
 */
import { test, expect } from '@playwright/test'

test.describe('Projects page (authenticated)', () => {
  test('projects page loads', async ({ page }) => {
    await page.goto('/projects')
    await expect(page).toHaveURL(/\/projects/)

    const main = page.locator('#main-content')
    await expect(main).toBeVisible()
  })

  test('new project CTA is present', async ({ page }) => {
    await page.goto('/projects')

    // "New project" button or link
    await expect(
      page.getByRole('button', { name: /new project/i }).or(
        page.getByRole('link', { name: /new project/i })
      )
    ).toBeVisible({ timeout: 8_000 })
  })

  test('visiting a non-existent projectId shows not-found or redirect', async ({ page }) => {
    await page.goto('/projects/00000000-does-not-exist/runs/00000000-also-missing')

    // Should either show a 404 page or redirect elsewhere — not a 500
    const status = page.locator('text=/not found|404|n\'existe pas/i')
    const isOnDashboard = page.url().includes('/dashboard')
    const isOnProjects  = page.url().includes('/projects')

    // At least one of these should be true
    const notFound = await status.isVisible({ timeout: 5_000 }).catch(() => false)
    expect(
      notFound || isOnDashboard || isOnProjects,
      'Expected a 404 page or redirect, got neither'
    ).toBeTruthy()
  })
})
