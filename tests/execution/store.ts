// tests/execution/store.ts
// InMemoryRunStore — minimal in-memory ExecutorDb for unit tests.
// Extracted from executor.ts so production code has zero test-only classes.

import type { ExecutorDb } from '@/lib/execution/engine.interface'

/** Minimal in-memory DB that satisfies ExecutorDb — used in unit tests. */
export class InMemoryRunStore implements ExecutorDb {
  private _runs = new Map<string, Record<string, unknown>>()
  private _nodes = new Map<string, Array<Record<string, unknown>>>()
  private _auditLog: unknown[] = []
  private _handoffs: unknown[] = []

  seedRun(run: Record<string, unknown>): void {
    this._runs.set(run['id'] as string, { ...run })
    if (!this._nodes.has(run['id'] as string)) {
      this._nodes.set(run['id'] as string, [])
    }
  }

  seedNode(runId: string, node: Record<string, unknown>): void {
    const list = this._nodes.get(runId) ?? []
    // Auto-assign a unique id if not provided — prevents update() from matching wrong rows.
    const nodeWithId = node['id'] != null ? node : { ...node, id: crypto.randomUUID() }
    list.push(nodeWithId)
    this._nodes.set(runId, list)
  }

  getAuditLog(): unknown[] {
    return this._auditLog
  }

  // ─── ExecutorDb impl ───────────────────────────────────────────────────────

  run = {
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const r = this._runs.get(where.id)
      if (!r) throw new Error(`Run not found: ${where.id}`)
      return r as unknown as ReturnType<ExecutorDb['run']['findUniqueOrThrow']> extends Promise<infer T> ? T : never
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = this._runs.get(where.id)
      if (!r) throw new Error(`Run not found: ${where.id}`)
      Object.assign(r, data)
      return r as unknown as ReturnType<ExecutorDb['run']['update']> extends Promise<infer T> ? T : never
    },
  }

  node = {
    findMany: async ({ where }: { where: { run_id: string } }) => {
      return (this._nodes.get(where.run_id) ?? []) as unknown as ReturnType<ExecutorDb['node']['findMany']> extends Promise<infer T> ? T : never
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const node = { id: crypto.randomUUID(), ...data }
      const list = this._nodes.get(data['run_id'] as string) ?? []
      list.push(node)
      this._nodes.set(data['run_id'] as string, list)
      return node as unknown as ReturnType<ExecutorDb['node']['create']> extends Promise<infer T> ? T : never
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      let found: Record<string, unknown> | undefined
      for (const list of this._nodes.values()) {
        found = list.find(n => n['id'] === where.id) as Record<string, unknown> | undefined
        if (found) { Object.assign(found, data); break }
      }
      if (!found) throw new Error(`Node not found: ${where.id}`)
      return found as unknown as ReturnType<ExecutorDb['node']['update']> extends Promise<infer T> ? T : never
    },
    findOrphaned: async ({ before }: { before: Date }) => {
      const result: Record<string, unknown>[] = []
      for (const list of this._nodes.values()) {
        for (const node of list) {
          if (
            node['status'] === 'RUNNING' &&
            node['last_heartbeat'] != null &&
            (node['last_heartbeat'] as Date) < before
          ) {
            result.push(node)
          }
        }
      }
      return result as unknown as ReturnType<ExecutorDb['node']['findOrphaned']> extends Promise<infer T> ? T : never
    },
    updateMany: async ({ where, data }: { where: { run_id: string; status?: string }; data: Record<string, unknown> }) => {
      let count = 0
      const list = this._nodes.get(where.run_id) ?? []
      for (const node of list) {
        if (!where.status || node['status'] === where.status) {
          Object.assign(node, data)
          count++
        }
      }
      return { count } as unknown as ReturnType<ExecutorDb['node']['updateMany']> extends Promise<infer T> ? T : never
    },
  }

  handoff = {
    create: async ({ data }: { data: unknown }) => {
      this._handoffs.push(data)
      return data
    },
  }

  auditLog = {
    create: async ({ data }: { data: unknown }) => {
      this._auditLog.push(data)
      return data
    },
  }
}
