'use client'

// components/run/HumanGateModal.tsx
// Inline gate decision UI — compact, embeddable in kanban cards and run lists.
// Full gate UI is at gate/gate-client.tsx. This is the lightweight version.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { CheckCircle2, XCircle, Loader2, AlertTriangle } from 'lucide-react'

interface HumanGateModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  runId: string
  gateId: string
  reason: string
  /** Navigate to full gate page on "Review details" */
  projectId?: string
}

export function HumanGateModal({
  open, onOpenChange, runId, gateId, reason, projectId,
}: HumanGateModalProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [loading, setLoading] = useState<'approve' | 'reject' | null>(null)

  async function decide(action: 'approve' | 'reject') {
    setLoading(action)
    try {
      const res = await fetch(`/api/runs/${runId}/gate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gate_id: gateId, action }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast({
        title: action === 'approve' ? 'Approved' : 'Rejected',
        description: action === 'approve' ? 'The run will continue.' : 'The run has been aborted.',
      })
      onOpenChange(false)
      router.refresh()
    } catch {
      toast({ title: 'Failed to submit decision', variant: 'destructive' })
    } finally {
      setLoading(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden />
            Human Gate — Review required
          </DialogTitle>
          <DialogDescription className="sr-only">
            Review and approve or reject this gate decision.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <Badge variant="paused" className="text-xs">Gate open</Badge>
          <p className="text-sm text-muted-foreground">{reason || 'Human review is required before this run continues.'}</p>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          {projectId && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onOpenChange(false)
                router.push(`/projects/${projectId}/runs/${runId}/gate`)
              }}
            >
              Review details
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="border-red-500/40 text-red-400 hover:bg-red-500/10"
            onClick={() => decide('reject')}
            disabled={loading !== null}
          >
            {loading === 'reject' ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
            Reject
          </Button>
          <Button
            size="sm"
            onClick={() => decide('approve')}
            disabled={loading !== null}
          >
            {loading === 'approve' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
