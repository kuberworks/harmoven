/**
 * tests/e2e/setup.ts
 * Global Playwright setup: logs in once and persists the authenticated
 * browser state to tests/e2e/.auth/user.json.
 *
 * All test projects that depend on [setup] will reuse this state instead
 * of performing a fresh login per test file — making the suite faster.
 *
 * Credentials: loaded from .env (HARMOVEN_ADMIN_EMAIL / HARMOVEN_ADMIN_PASSWORD).
 */
import { test as setup, expect } from '@playwright/test'
import path from 'path'

const AUTH_FILE = path.join(__dirname, '.auth/user.json')

const EMAIL    = process.env.HARMOVEN_ADMIN_EMAIL    ?? 'admin@harmoven.local'
const PASSWORD = process.env.HARMOVEN_ADMIN_PASSWORD ?? 'Admin1234!'

setup('authenticate', async ({ page }) => {
  await page.goto('/login')

  // Wait for the card/form to be visible
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()

  // Fill email + password
  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  // Wait for redirect to dashboard after successful login
  await page.waitForURL('**/dashboard', { timeout: 15_000 })
  await expect(page).toHaveURL(/\/dashboard/)

  // Save auth state so all other tests reuse the session
  await page.context().storageState({ path: AUTH_FILE })
})
