// components/run/RunStatusBadge.tsx
// Standardized run status badge used across all pages.
// Status colors match DESIGN_SYSTEM.md §1.2 semantic tokens.

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils/cn'

type RunStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PAUSED' | 'SUSPENDED' | string

const STATUS_VARIANT: Record<string, 'running' | 'completed' | 'failed' | 'paused' | 'suspended' | 'pending'> = {
  RUNNING:   'running',
  COMPLETED: 'completed',
  FAILED:    'failed',
  PAUSED:    'paused',
  SUSPENDED: 'suspended',
  PENDING:   'pending',
}

const STATUS_LABEL: Record<string, string> = {
  RUNNING:   'Running',
  COMPLETED: 'Completed',
  FAILED:    'Failed',
  PAUSED:    'Paused',
  SUSPENDED: 'Suspended',
  PENDING:   'Pending',
}

interface RunStatusBadgeProps {
  status: RunStatus
  className?: string
  /** Show a pulsing dot indicator for active states */
  animated?: boolean
}

export function RunStatusBadge({ status, className, animated }: RunStatusBadgeProps) {
  const variant = STATUS_VARIANT[status] ?? 'pending'
  const label = STATUS_LABEL[status] ?? status

  return (
    <Badge
      variant={variant}
      className={cn('gap-1.5 font-medium', className)}
    >
      {animated && (status === 'RUNNING' || status === 'PAUSED') && (
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            status === 'RUNNING' && 'animate-pulse bg-[var(--color-status-running)]',
            status === 'PAUSED'  && 'animate-pulse bg-[var(--color-status-paused)]',
          )}
          aria-hidden
        />
      )}
      {label}
    </Badge>
  )
}
