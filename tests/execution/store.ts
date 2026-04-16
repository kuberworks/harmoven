// tests/execution/store.ts
// InMemoryRunStore — minimal in-memory ExecutorDb for unit tests.
// Extracted from executor.ts so production code has zero test-only classes.

import type { ExecutorDb, SpawnRunData } from '@/lib/execution/engine.interface'

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
    create: async ({ data }: { data: SpawnRunData }) => {
      const run = { ...data }
      this._runs.set(run.id as string, run as unknown as Record<string, unknown>)
      this._nodes.set(run.id as string, [])
      return { id: run.id as string }
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
    updateMany: async ({ where, data }: { where: { id?: string | { in: string[] }; run_id?: string; node_id?: string | { in: string[] }; status?: string | { in: string[] } }; data: Record<string, unknown> }) => {
      let count = 0
      const pools = where.run_id
        ? [this._nodes.get(where.run_id) ?? []]
        : [...this._nodes.values()]
      for (const list of pools) {
        for (const node of list) {
          const idMatch = !where.id
            ? true
            : typeof where.id === 'string'
              ? node['id'] === where.id
              : (where.id as { in: string[] }).in.includes(node['id'] as string)
          const nodeIdMatch = !where.node_id
            ? true
            : typeof where.node_id === 'string'
              ? node['node_id'] === where.node_id
              : (where.node_id as { in: string[] }).in.includes(node['node_id'] as string)
          const statusMatch = !where.status
            ? true
            : typeof where.status === 'string'
              ? node['status'] === where.status
              : (where.status as { in: string[] }).in.includes(node['status'] as string)
          if (idMatch && nodeIdMatch && statusMatch) {
            Object.assign(node, data)
            count++
          }
        }
      }
      return { count } as unknown as ReturnType<ExecutorDb['node']['updateMany']> extends Promise<infer T> ? T : never
    },
    createMany: async ({ data }: { data: unknown[] }) => {
      let count = 0
      for (const nodeData of data) {
        const n = nodeData as Record<string, unknown>
        const node = { id: crypto.randomUUID(), ...n }
        const list = this._nodes.get(n['run_id'] as string) ?? []
        list.push(node)
        this._nodes.set(n['run_id'] as string, list)
        count++
      }
      return { count }
    },
    deleteMany: async ({ where }: { where: { run_id: string; node_id: { in: string[] } } }) => {
      const list = this._nodes.get(where.run_id) ?? []
      const toDelete = new Set(where.node_id.in)
      const newList = list.filter(n => !toDelete.has(n['node_id'] as string))
      const count = list.length - newList.length
      this._nodes.set(where.run_id, newList)
      return { count }
    },
  }

  handoff = {
    create: async ({ data }: { data: unknown }) => {
      this._handoffs.push(data)
      return data
    },
    aggregate: async ({ where }: { where: { run_id: string }; _max: { sequence_number: true } }) => {
      const existing = this._handoffs.filter(
        (h): h is { run_id: string; sequence_number: number } =>
          typeof h === 'object' && h !== null && (h as Record<string, unknown>).run_id === where.run_id,
      )
      const max = existing.reduce((m, h) => Math.max(m, h.sequence_number ?? 0), 0)
      return { _max: { sequence_number: existing.length > 0 ? max : null } }
    },
    createAtomic: async (data: { run_id: string; source_agent: string; source_node_id: string | null | undefined; target_agent: string; payload: unknown }) => {
      // In-memory: no concurrency in tests, compute sequence_number inline.
      const existing = this._handoffs.filter(
        (h) => typeof h === 'object' && h !== null && (h as Record<string, unknown>).run_id === data.run_id,
      )
      const max = existing.reduce((m, h) => Math.max(m as number, Number((h as Record<string, unknown>).sequence_number ?? 0)), 0)
      this._handoffs.push({ ...data, sequence_number: (max as number) + 1 })
    },
  }

  humanGate = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const gate = { id: crypto.randomUUID(), ...data }
      return gate as { id: string }
    },
    updateMany: async (_args: unknown) => ({ count: 0 }),
  }

  auditLog = {
    create: async ({ data }: { data: unknown }) => {
      this._auditLog.push(data)
      return data
    },
  }

  runDependency = {
    create: async (_args: unknown) => ({}),
    findMany: async (_args: unknown) => [] as Array<{ parent_run: { id: string; status: string } }>,
  }

  runArtifact = {
    // No-op stubs — tests that exercise artifact logic should use a real DB or
    // a more specific mock. These stubs prevent "Cannot read properties of undefined"
    // errors in tests that exercise node-reset paths (replay_from_scratch, replayNode).
    updateMany: async (_args: unknown) => ({ count: 0 }),
    deleteMany: async (_args: unknown) => ({ count: 0 }),
  }
}
