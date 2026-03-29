// app/(app)/admin/models/page.tsx
// Admin — LLM profile list.
// Server Component. instance_admin only.
// UX spec §3.8 — Admin / LLM models.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Cpu } from 'lucide-react'

export const metadata: Metadata = { title: 'LLM Models — Admin' }

const TIER_VARIANT: Record<string, 'running' | 'pending' | 'paused'> = {
  fast:     'running',
  balanced: 'paused',
  powerful: 'pending',
}

const TRUST_LABEL: Record<number, string> = { 1: 'Public', 2: 'Private', 3: 'Local' }

export default async function AdminModelsPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')
  const instanceRole = (session.user as Record<string, unknown>).role as string | null
  if (instanceRole !== 'instance_admin') redirect('/dashboard')

  const models = await db.llmProfile.findMany({ orderBy: [{ enabled: 'desc' }, { tier: 'asc' }, { id: 'asc' }] })

  return (
    <div className="space-y-6 animate-stagger">
      <div>
        <h1 className="text-xl font-semibold text-foreground">LLM Models</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {models.filter((m) => m.enabled).length} active / {models.length} total profiles
        </p>
      </div>

      {models.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Cpu className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No LLM profiles configured.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 divide-y divide-surface-border">
            {models.map((m) => (
              <div key={m.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground font-mono">{m.id}</span>
                    <Badge variant={TIER_VARIANT[m.tier] ?? 'pending'}>{m.tier}</Badge>
                    {!m.enabled && <Badge variant="suspended">disabled</Badge>}
                  </div>
                  <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground flex-wrap">
                    <span>{m.provider}</span>
                    <span>·</span>
                    <span>{(m.context_window / 1000).toFixed(0)}k ctx</span>
                    <span>·</span>
                    <span>Trust: {TRUST_LABEL[m.trust_tier] ?? m.trust_tier}</span>
                    <span>·</span>
                    <span>{m.jurisdiction.toUpperCase()}</span>
                  </div>
                  <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground font-mono">
                    <span>In: €{Number(m.cost_per_1m_input_tokens).toFixed(2)}/1M</span>
                    <span>Out: €{Number(m.cost_per_1m_output_tokens).toFixed(2)}/1M</span>
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
