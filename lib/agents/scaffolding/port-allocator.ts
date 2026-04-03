// lib/agents/scaffolding/port-allocator.ts
// Port allocator for preview containers — Amendment 73, Section 25.6.
//
// Range: APP_SCAFFOLDING_PREVIEW_PORT_RANGE_START (3100) to _END (3199).
// Each port record is tied to a run_id (unique). Released on Human Gate resolution.
// Max concurrent previews = range size (default 100).
// Beyond range: throws PortExhaustedError — caller falls back to screenshots.

import { db } from '@/lib/db/client'

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT_START = parseInt(process.env.APP_SCAFFOLDING_PREVIEW_PORT_RANGE_START ?? '3100', 10)
const PORT_END   = parseInt(process.env.APP_SCAFFOLDING_PREVIEW_PORT_RANGE_END   ?? '3199', 10)

export class PortExhaustedError extends Error {
  constructor() {
    super(`No preview port available — all ports ${PORT_START}–${PORT_END} are claimed (max ${PORT_END - PORT_START + 1} concurrent previews)`)
    this.name = 'PortExhaustedError'
  }
}

// ─── Allocate ─────────────────────────────────────────────────────────────────

/**
 * Claim the next free port in the 3100–3199 range for a run.
 * Stored in DB to prevent collision across concurrent runs and process restarts.
 *
 * Throws PortExhaustedError if all ports are claimed.
 */
export async function allocatePreviewPort(runId: string): Promise<number> {
  // Check if this run already has a port (idempotent)
  const existing = await db.previewPort.findUnique({ where: { run_id: runId } })
  if (existing) return existing.port as number

  // Scan range for an unclaimed port
  for (let port = PORT_START; port <= PORT_END; port++) {
    const inUse = await db.previewPort.findUnique({ where: { port } })
    if (!inUse) {
      try {
        await db.previewPort.create({ data: { port, run_id: runId } })
        return port
      } catch {
        // Unique constraint violation: another concurrent request claimed this port.
        // Continue to the next one.
        continue
      }
    }
  }

  throw new PortExhaustedError()
}

// ─── Release ──────────────────────────────────────────────────────────────────

/**
 * Release the port claimed for a run.
 * Called on Human Gate resolution (approve/abandon) and on run failure.
 * Safe to call multiple times (idempotent).
 */
export async function releasePreviewPort(runId: string): Promise<void> {
  await db.previewPort.deleteMany({ where: { run_id: runId } }).catch(() => {})
}

/**
 * Return the port currently allocated for a run, or null if not allocated.
 */
export async function getPreviewPort(runId: string): Promise<number | null> {
  const row = await db.previewPort.findUnique({ where: { run_id: runId } })
  return row ? (row.port as number) : null
}
