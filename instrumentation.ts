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
  }
}
