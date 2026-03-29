// instrumentation.ts
// Next.js instrumentation hook — runs once at server startup (stable in Next.js 15).
// Spec: BUG-003 — bootstrap functions were defined but never called.
//
// Calls are scoped to the Node.js runtime to avoid running in the Edge runtime
// or during client-side rendering where these modules are not available.
//
// References:
//   - lib/bootstrap/validate-argon2-memory.ts (Am.92 §8)
//   - lib/bootstrap/verify-mcp-skills.ts
//   - lib/bootstrap/sync-instance-config.ts

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { validateArgon2Memory }       = await import('@/lib/bootstrap/validate-argon2-memory')
    const { verifyMCPSkillsFromConfig } = await import('@/lib/bootstrap/verify-mcp-skills')
    const { syncInstanceConfig }        = await import('@/lib/bootstrap/sync-instance-config')

    // Synchronous — throws if Argon2 memory configuration is dangerously low.
    validateArgon2Memory()

    // Non-blocking — a missing or broken MCP skill pack must not prevent startup.
    await verifyMCPSkillsFromConfig().catch((err: unknown) =>
      console.warn('[bootstrap] verifyMCPSkillsFromConfig failed (non-fatal):', err),
    )

    // Non-blocking — config sync failure must not block the server from starting.
    await syncInstanceConfig().catch((err: unknown) =>
      console.warn('[bootstrap] syncInstanceConfig failed (non-fatal):', err),
    )

    // B-02: sweep OPEN gates whose timeout_at is in the past (catches gates
    // that expired while the server was down). Also starts the periodic sweep.
    const { sweepExpiredGates, startGateSweep } = await import('@/lib/execution/gate-timeout')
    await sweepExpiredGates().catch((err: unknown) =>
      console.warn('[bootstrap] sweepExpiredGates failed (non-fatal):', err),
    )
    startGateSweep()

    // Pre-initialise the execution engine singleton at server startup so that
    // the db + LLM client are wired in the instrumentation context (stable module
    // scope, no HMR interference). Without this, the engine is created lazily on
    // the first POST /api/runs request where module timing can leave this.db undefined.
    const { getExecutionEngine } = await import('@/lib/execution/engine.factory')
    await getExecutionEngine().catch((err: unknown) =>
      console.warn('[bootstrap] getExecutionEngine pre-init failed (non-fatal):', err),
    )

    // RGPD-03: purge expired sessions (contains IP + UA — personal data).
    // RGPD-04: purge personal data content from expired runs (task_input, injections, Node LLM text).
    // Crons always start; they check the live admin config (PATCH /api/admin/rgpd) at each sweep.
    // Admin toggle: maintenance_enabled (DB via SystemSetting) — env var RGPD_MAINTENANCE_ENABLED=false overrides.
    const { startSessionCleanupCron } = await import('@/lib/maintenance/session-cleanup')
    const { startRunDataTtlCron }     = await import('@/lib/maintenance/run-data-ttl')
    startSessionCleanupCron()
    startRunDataTtlCron()
  }
}
