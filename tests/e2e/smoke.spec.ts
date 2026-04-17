/**
 * tests/e2e/smoke.spec.ts
 * Lightweight smoke tests for staging.
 *
 * Two reliable assertions that don't depend on DB state or JS hydration:
 *  1. /api/health returns { status: 'ok' }
 *  2. Root redirects to /login or /setup and page has a title
 *
 * Run: npx playwright test --project=smoke
 */
import { test, expect } from '@playwright/test'

test.use({ storageState: { cookies: [], origins: [] } })

test('@smoke health endpoint returns ok', async ({ request }) => {
  const resp = await request.get('/api/health')
  expect(resp.status()).toBe(200)
  const body = await resp.json()
  expect(body).toMatchObject({ status: 'ok' })
})

test('@smoke unauthenticated root redirects to login or setup', async ({ page }) => {
  await page.goto('/')
  await page.waitForURL(/\/(login|setup)/, { timeout: 20_000 })
  expect(page.url()).toMatch(/\/(login|setup)/)
  // SSR title is present on both /login and /setup — no JS hydration needed
  await expect(page).toHaveTitle(/.+/, { timeout: 10_000 })
})
