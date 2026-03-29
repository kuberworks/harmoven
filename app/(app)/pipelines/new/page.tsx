'use client'
// app/(app)/pipelines/new/page.tsx
// Create a new pipeline template — Client Component wrapping PipelineBuilder.

import { useRouter } from 'next/navigation'
import { PipelineBuilder } from '@/components/pipeline/PipelineBuilder'
import type { Dag } from '@/types/dag.types'

export default function NewPipelinePage() {
  const router = useRouter()

  function onSaved({ id }: { id: string; name: string; dag: Dag }) {
    router.push(`/pipelines/${id}`)
  }

  return (
    <div className="flex flex-col h-[calc(100vh-56px)]">
      <div className="border-b border-border px-6 py-3 bg-background shrink-0">
        <h1 className="text-lg font-semibold">New Pipeline Template</h1>
        <p className="text-sm text-muted-foreground">
          Drag agents from the palette, connect them, then save.
        </p>
      </div>
      <div className="flex-1 min-h-0">
        <PipelineBuilder onSaved={onSaved} />
      </div>
    </div>
  )
}
