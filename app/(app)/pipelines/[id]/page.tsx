// app/(app)/pipelines/[id]/page.tsx
// View + edit a pipeline template. Shows:
//  - The visual DAG builder (edit mode)
//  - Version history
//  - AI suggestion banner (if pending)

import type { Metadata }  from 'next'
import { headers }        from 'next/headers'
import { redirect, notFound } from 'next/navigation'
import { auth }           from '@/lib/auth'
import { getTemplate }    from '@/lib/pipeline/templates'
import { PipelineDetailClient } from './PipelineDetailClient'

export const metadata: Metadata = { title: 'Pipeline Template' }

type Props = { params: Promise<{ id: string }> }

export default async function PipelineDetailPage({ params }: Props) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const { id } = await params
  const template = await getTemplate(id)
  if (!template) notFound()

  return (
    <PipelineDetailClient
      template={template}
      currentUserId={session.user.id}
    />
  )
}
