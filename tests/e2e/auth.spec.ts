/**
 * tests/e2e/auth.spec.ts
 * Authentication flow E2E tests (unauthenticated Chrome project).
 *
 * Covers:
 *  - Unauthenticated access redirects to /login
 *  - Login page renders correctly
 *  - Successful login with valid credentials → dashboard
 *  - Failed login with wrong password shows error toast
 *  - Logout from user menu → /login
 */
import { test, expect } from '@playwright/test'

const EMAIL    = process.env.HARMOVEN_ADMIN_EMAIL    ?? 'admin@harmoven.local'
const PASSWORD = process.env.HARMOVEN_ADMIN_PASSWORD ?? 'Admin1234!'

test.describe('Authentication', () => {
  test('unauthenticated user is redirected to /login', async ({ page }) => {
    await page.goto('/dashboard')
    await page.waitForURL(/\/login/, { timeout: 10_000 })
    await expect(page).toHaveURL(/\/login/)
  })

  test('login page renders form elements', async ({ page }) => {
    await page.goto('/login')

    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByLabel('Email')).toBeVisible()
    await expect(page.getByLabel('Password')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /passkey/i })).toBeVisible()
  })

  test('successful login redirects to /dashboard', async ({ page }) => {
    await page.goto('/login')

    await page.getByLabel('Email').fill(EMAIL)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()

    await page.waitForURL('**/dashboard', { timeout: 15_000 })
    await expect(page).toHaveURL(/\/dashboard/)

    // Sidebar should be visible after login
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible()
  })

  test('wrong password shows error toast', async ({ page }) => {
    await page.goto('/login')

    await page.getByLabel('Email').fill(EMAIL)
    await page.getByLabel('Password').fill('wrongpassword123')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()

    // Expect destructive toast
    await expect(
      page.getByText(/sign in failed|invalid email or password/i)
    ).toBeVisible({ timeout: 8_000 })

    // Should stay on login
    await expect(page).toHaveURL(/\/login/)
  })

  test('callbackURL is respected after login', async ({ page }) => {
    await page.goto('/login?callbackURL=/projects')

    await page.getByLabel('Email').fill(EMAIL)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()

    // Must land on /projects, not /dashboard
    await page.waitForURL('**/projects', { timeout: 15_000 })
    await expect(page).toHaveURL(/\/projects/)
  })

  test('logout from user menu returns to /login', async ({ page }) => {
    // First, log in
    await page.goto('/login')
    await page.getByLabel('Email').fill(EMAIL)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.waitForURL('**/dashboard', { timeout: 15_000 })

    // Open user menu
    const userMenuButton = page.locator('[aria-controls="user-menu"]')
    await userMenuButton.click()

    // Click sign out
    await page.getByRole('menuitem', { name: /sign out|log out|se déconnecter/i }).click()

    // Should land on /login
    await page.waitForURL(/\/login/, { timeout: 10_000 })
    await expect(page).toHaveURL(/\/login/)
  })
})
