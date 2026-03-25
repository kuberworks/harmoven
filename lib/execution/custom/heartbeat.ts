// lib/execution/custom/heartbeat.ts
// HeartbeatManager — pulses last_heartbeat every HEARTBEAT_INTERVAL_MS for each RUNNING node.
// Orphan detection on startup marks stale nodes as INTERRUPTED.
// Amendment 34.3a — T1.5 scope.

/** How often to emit a heartbeat for each running node (30 s). */
export const HEARTBEAT_INTERVAL_MS = 30_000

/** Nodes not pulsed within this window are considered orphaned (3 × heartbeat = 90 s). */
export const ORPHAN_THRESHOLD_MS = 3 * HEARTBEAT_INTERVAL_MS

/**
 * Manages per-node setInterval timers.
 * Each running node gets an interval that fires the `pulse` callback.
 * The callback should write `last_heartbeat: new Date()` to the database.
 */
export class HeartbeatManager {
  private readonly _timers = new Map<string, ReturnType<typeof setInterval>>()

  /**
   * Start a heartbeat for `nodeId`.
   * No-op if one is already active for this node.
   *
   * @param nodeId  DB node id
   * @param pulse   Async fn that writes last_heartbeat to the DB.
   * @param intervalMs  Override the default HEARTBEAT_INTERVAL_MS (useful in tests).
   */
  start(nodeId: string, pulse: () => Promise<void>, intervalMs = HEARTBEAT_INTERVAL_MS): void {
    if (this._timers.has(nodeId)) return
    const timer = setInterval(() => { void pulse() }, intervalMs)
    this._timers.set(nodeId, timer)
  }

  /**
   * Stop and clear the heartbeat for `nodeId`.
   * Called when a node completes, fails, or is interrupted.
   */
  stop(nodeId: string): void {
    const timer = this._timers.get(nodeId)
    if (timer !== undefined) {
      clearInterval(timer)
      this._timers.delete(nodeId)
    }
  }

  /**
   * Stop all active heartbeats.
   * Called during graceful shutdown before process exit.
   */
  stopAll(): void {
    for (const nodeId of [...this._timers.keys()]) {
      this.stop(nodeId)
    }
  }

  /** Number of nodes currently pulsing. */
  get activeCount(): number {
    return this._timers.size
  }
}
