/**
 * tests/e2e/a11y.spec.ts
 * Accessibility smoke tests (authenticated Chrome project).
 *
 * Covers:
 *  - Skip-nav link is the first focusable element
 *  - Main landmark (#main-content) exists
 *  - Page has a title
 *  - Sidebar nav has aria-label
 *  - User menu button has aria-expanded attribute
 *  - Tab order reaches main content via skip link
 */
import { test, expect } from '@playwright/test'

test.describe('Accessibility (authenticated)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard')
  })

  test('page has a <title>', async ({ page }) => {
    const title = await page.title()
    expect(title).toBeTruthy()
    expect(title.length).toBeGreaterThan(0)
  })

  test('<html> lang attribute is set', async ({ page }) => {
    const lang = await page.locator('html').getAttribute('lang')
    expect(lang).toBeTruthy()
    expect(['en', 'fr']).toContain(lang)
  })

  test('skip-nav link precedes sidebar', async ({ page }) => {
    const skipLink = page.getByRole('link', { name: /skip to main content/i })
    await expect(skipLink).toBeAttached()

    // Should be the first focusable element — pressing Tab once lands on it
    await page.keyboard.press('Tab')
    await expect(skipLink).toBeFocused()
  })

  test('skip-nav activates #main-content on Enter', async ({ page }) => {
    await page.keyboard.press('Tab')     // focus skip link
    await page.keyboard.press('Enter')   // activate it

    // #main-content should now be the active element (tabIndex=-1)
    const mainId = await page.evaluate(() => document.activeElement?.id)
    expect(mainId).toBe('main-content')
  })

  test('main landmark exists with id="main-content"', async ({ page }) => {
    await expect(page.locator('#main-content')).toBeVisible()
    const role = await page.locator('#main-content').getAttribute('role')
    // Either implicit <main> or explicit role="main"
    const tagName = await page.locator('#main-content').evaluate(el => el.tagName.toLowerCase())
    expect(tagName === 'main' || role === 'main').toBeTruthy()
  })

  test('navigation has accessible label', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Main navigation' })
    await expect(nav).toBeVisible()
  })

  test('user menu button has aria-haspopup and aria-expanded', async ({ page }) => {
    const btn = page.locator('[aria-controls="user-menu"]')
    await expect(btn).toBeVisible()

    const haspopup = await btn.getAttribute('aria-haspopup')
    const expanded = await btn.getAttribute('aria-expanded')

    expect(haspopup).toBeTruthy()
    expect(expanded).toBe('false')

    // After click, expanded should be true
    await btn.click()
    await expect(btn).toHaveAttribute('aria-expanded', 'true')
  })
})
