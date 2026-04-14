// prisma.config.ts — Prisma 7 datasource configuration (project root)
// The `url` property was moved out of schema.prisma in Prisma 7.
// See: https://pris.ly/d/config-datasource
//
// dotenv is loaded explicitly because prisma.config.ts is evaluated before
// Prisma's internal .env loader runs.

import { defineConfig } from 'prisma/config'
import { config as loadDotEnv } from 'dotenv'
import { existsSync } from 'node:fs'
import path from 'node:path'

// Load .env for local dev — Prisma CLI runs before Next.js's env loader.
// In Docker/production the env vars are injected by the runtime (env_file:)
// and .env does not exist inside the container, so this is a no-op there.
const envPath = path.resolve(__dirname, '.env')
if (existsSync(envPath)) {
  loadDotEnv({ path: envPath })
}

export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL,
  },
})
