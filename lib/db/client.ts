// lib/db/client.ts
// Prisma 7 singleton — uses the @prisma/adapter-pg driver adapter (client engine).
// In Next.js dev mode, hot-reload creates new module instances;
// the global cache prevents connection pool exhaustion.

import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

function createClient() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is not set')
  const adapter = new PrismaPg({ connectionString })
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const db = globalForPrisma.prisma ?? createClient()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db
}
