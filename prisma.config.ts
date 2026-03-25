// prisma.config.ts — Prisma 7 datasource configuration (project root)
// The `url` property was moved out of schema.prisma in Prisma 7.
// See: https://pris.ly/d/config-datasource
//
// dotenv is loaded explicitly because prisma.config.ts is evaluated before
// Prisma's internal .env loader runs.

import { defineConfig } from 'prisma/config'
import { config as loadDotEnv } from 'dotenv'
import path from 'node:path'

loadDotEnv({ path: path.resolve(__dirname, '.env') })

export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL,
  },
})
