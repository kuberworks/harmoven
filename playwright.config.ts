import { defineConfig, devices } from '@playwright/test'

/**
 * playwright.config.ts
 * E2E test configuration for Harmoven.
 *
 * Uses Google Chrome (system-installed) so tests run against the real browser
 * the same way a user would. The dev server must be running on port 3000.
 *
 * Run: npx playwright test  (or: npm run test:e2e)
 * UI mode: npx playwright test --ui
 * Debug: npx playwright test --debug
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',

  /* Run tests in parallel within each file, but isolate files from each other. */
  fullyParallel: false,
  workers: 1,

  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,

  /* Retry on CI only. */
  retries: process.env.CI ? 2 : 0,

  /* Reporter: HTML report + terminal dots */
  reporter: [['html', { open: 'never', outputFolder: 'playwright-report' }], ['list']],

  use: {
    /* Base URL for all tests. Override with BASE_URL env var for remote staging. */
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',

    /* Trace on first retry for easier debugging. */
    trace: 'on-first-retry',

    /* Screenshot on failure. */
    screenshot: 'only-on-failure',

    /* Video on first retry. */
    video: 'on-first-retry',

    /* Default navigation timeout. */
    navigationTimeout: 15_000,

    /* Action timeout. */
    actionTimeout: 8_000,
  },

  projects: [
    /* ── Setup: creates a reusable authenticated auth state ── */
    {
      name: 'setup',
      testMatch: '**/setup.ts',
    },

    /* ── Chrome (system-installed Google Chrome) ── */
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        /* Reuse authenticated state (populated by setup project). */
        storageState: 'tests/e2e/.auth/user.json',
      },
      dependencies: ['setup'],
    },

    /* ── Unauthenticated tests (auth flow) — no storageState ── */
    {
      name: 'chromium-unauth',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
      },
      testMatch: '**/auth.spec.ts',
    },

    /* ── Staging smoke tests — no auth, no local server required ── */
    {
      name: 'smoke',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
      },
      testMatch: '**/smoke.spec.ts',
    },
  ],

  /* In CI smoke tests against a remote URL (BASE_URL set), skip the local
     webServer entirely. Locally (or in E2E with a local build), start the
     standalone server. */
  ...(process.env.BASE_URL
    ? {}
    : {
        webServer: {
          command: 'node .next/standalone/server.js',
          url: 'http://localhost:3000',
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      }),
})
