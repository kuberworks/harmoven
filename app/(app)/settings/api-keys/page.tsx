// app/(app)/settings/api-keys/page.tsx
// User-level API key management.
// Server Component: fetches existing keys via Better Auth API key plugin.
// UX spec §3.11 — API Keys.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { ApiKeysClient, type ApiKeyRow } from './api-keys-client'

export const metadata: Metadata = { title: 'API Keys — Settings' }

export default async function ApiKeysPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  let apiKeys: ApiKeyRow[] = []
  try {
    // @ts-expect-error - api-key plugin types vary
    const res = await auth.api.listApiKeys?.({ headers: await headers() })
    if (Array.isArray(res)) {
      apiKeys = res.map((k) => ({
        id:         k.id,
        name:       k.name ?? 'Unnamed key',
        start:      (k.start ?? k.prefix ?? k.id.slice(0, 8)) + '…',
        createdAt:  (k.createdAt instanceof Date ? k.createdAt : new Date(k.createdAt)).toISOString(),
        lastUsedAt: k.lastUsedAt
          ? (k.lastUsedAt instanceof Date ? k.lastUsedAt : new Date(k.lastUsedAt)).toISOString()
          : null,
        expiresAt:  k.expiresAt
          ? (k.expiresAt instanceof Date ? k.expiresAt : new Date(k.expiresAt)).toISOString()
          : null,
      }))
    }
  } catch {
    // Plugin not enabled or no keys
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground">API Keys</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Create personal API keys to access the Harmoven API programmatically.
        </p>
      </div>

      <ApiKeysClient initialKeys={apiKeys} />
    </div>
  )
}
