'use client'

// Approve / enable / disable a single MCP skill.
// Approve:  PATCH /api/admin/skills/:id  { approved: true }
// Enable:   PATCH /api/admin/skills/:id  { enabled: true  }
// Disable:  PATCH /api/admin/skills/:id  { enabled: false }

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'

interface Props {
  skillId:    string
  enabled:    boolean
  scanStatus: string
  approvedBy: string | null
}

export function SkillActionsClient({ skillId, enabled, scanStatus, approvedBy }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState<string | null>(null)

  async function patch(body: Record<string, unknown>, action: string) {
    setLoading(action)
    try {
      const res = await fetch(`/api/admin/skills/${skillId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(await res.text())
      router.refresh()
    } finally {
      setLoading(null)
    }
  }

  const busy = loading !== null

  return (
    <div className="flex items-center gap-2 shrink-0">
      {/* Approve — only when scan passed and not yet approved */}
      {scanStatus === 'passed' && !approvedBy && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => patch({ approved: true }, 'approve')}
        >
          {loading === 'approve' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Approve'}
        </Button>
      )}

      {/* Enable / Disable */}
      {enabled ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => patch({ enabled: false }, 'disable')}
        >
          {loading === 'disable' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Disable'}
        </Button>
      ) : (
        <Button
          size="sm"
          disabled={busy || !approvedBy}
          onClick={() => patch({ enabled: true }, 'enable')}
          title={!approvedBy ? 'Skill must be approved before enabling' : undefined}
        >
          {loading === 'enable' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Enable'}
        </Button>
      )}
    </div>
  )
}
