// app/(app)/admin/models/page.tsx
// Admin — LLM profile management.
// Server Component: auth gate + data fetch. Renders ModelsAdminClient for interactivity.
// instance_admin only.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { ModelsAdminClient } from './models-client'
import type { LlmProfileRow } from './models-client'

export const metadata: Metadata = { title: 'LLM Models — Admin' }

export default async function AdminModelsPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')
  const instanceRole = (session.user as Record<string, unknown>).role as string | null
  if (instanceRole !== 'instance_admin') redirect('/dashboard')

  const raw = await db.llmProfile.findMany({ orderBy: [{ enabled: 'desc' }, { tier: 'asc' }, { id: 'asc' }] })

  // Serialize Decimal fields to plain numbers so they can cross the server/client boundary
  const models: LlmProfileRow[] = raw.map((m) => ({
    id:                        m.id,
    provider:                  m.provider,
    model_string:              m.model_string,
    tier:                      m.tier,
    jurisdiction:              m.jurisdiction,
    trust_tier:                m.trust_tier,
    context_window:            m.context_window,
    cost_per_1m_input_tokens:  Number(m.cost_per_1m_input_tokens),
    cost_per_1m_output_tokens: Number(m.cost_per_1m_output_tokens),
    task_type_affinity:        m.task_type_affinity,
    enabled:                   m.enabled,
    config:                    (m.config ?? {}) as Record<string, unknown>,
  }))

  return (
    <div className="space-y-6 animate-stagger">
      <ModelsAdminClient initialModels={models} />
    </div>
  )
}
