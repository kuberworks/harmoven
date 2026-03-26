// lib/db/client.ts
// Prisma 7 singleton — uses the @prisma/adapter-pg driver adapter (client engine).
// In Next.js dev mode, hot-reload creates new module instances;
// the global cache prevents connection pool exhaustion.
//
// Lazy initialization: createClient() is deferred until db is first *used*,
// not at module load time. This allows modules that import `db` to be safely
// required in unit-test environments that don't set DATABASE_URL.

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

// Proxy-based lazy singleton: PrismaClient is created on first property access,
// not when this module is imported. Safe for test environments without DATABASE_URL.
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    if (!globalForPrisma.prisma) {
      globalForPrisma.prisma = createClient()
    }
    const value = (globalForPrisma.prisma as any)[prop]
    return typeof value === 'function' ? value.bind(globalForPrisma.prisma) : value
  },
})
