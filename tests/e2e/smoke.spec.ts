/**
 * tests/e2e/smoke.spec.ts
 * Lightweight smoke tests for staging (@smoke tag).
 *
 * These run against the live Render staging URL (BASE_URL env var).
 * No credentials needed — only checks public-facing pages/endpoints.
 *
 * Run: npx playwright test --grep "@smoke" --project=chromium
 */
import { test, expect } from '@playwright/test'

test.use({ storageState: { cookies: [], origins: [] } })

test('@smoke health endpoint returns ok', async ({ request }) => {
  const resp = await request.get('/api/health')
  expect(resp.status()).toBe(200)
  const body = await resp.json()
  expect(body).toMatchObject({ status: 'ok' })
})

test('@smoke unauthenticated root redirects to login', async ({ page }) => {
  await page.goto('/')
  await page.waitForURL(/\/(login|setup)/, { timeout: 20_000 })
  expect(page.url()).toMatch(/\/(login|setup)/)
})

test('@smoke login page renders sign-in form', async ({ page }) => {
  // On a fresh DB (CI), /login redirects to /setup (wizard not complete yet).
  // On a seeded DB, it stays on /login. Accept both.
  await page.goto('/login')
  await page.waitForLoadState('networkidle', { timeout: 30_000 })
  const url = page.url()
  if (url.includes('/setup')) {
    // Fresh DB: setup wizard page — just check the page rendered something visible
    await expect(page.locator('body')).not.toBeEmpty()
    await expect(page.locator('h1, h2, [role="heading"]').first()).toBeVisible({ timeout: 10_000 })
  } else {
    // Seeded DB: check login form
    await expect(page.locator('#email')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('#password')).toBeVisible()
  }
})
