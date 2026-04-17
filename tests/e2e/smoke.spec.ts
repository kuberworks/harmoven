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
  const resp = await page.goto('/login')
  // Accept both 200 (direct) and any 2xx/3xx — just check the final page has the form
  await page.waitForLoadState('networkidle', { timeout: 30_000 })
  // Locate by id to avoid locale-dependent label text
  await expect(page.locator('#email')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('#password')).toBeVisible()
  await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible()
})
