// lib/utils/run-status.ts
// Shared status → Badge variant mapping for Run and Node rows.
// Single source of truth — imported by Dashboard, RunDetail, RunsKanban.

export type RunStatusVariant = 'running' | 'completed' | 'failed' | 'paused' | 'pending' | 'suspended'

export const RUN_STATUS_VARIANT: Record<string, RunStatusVariant> = {
  RUNNING:     'running',
  COMPLETED:   'completed',
  FAILED:      'failed',
  PAUSED:      'paused',
  PENDING:     'pending',
  SUSPENDED:   'suspended',
  INTERRUPTED: 'paused',
  CANCELLED:   'pending',
  BLOCKED:     'pending',
  ESCALATED:   'failed',
  DEADLOCKED:  'failed',
  SKIPPED:     'pending',
}
