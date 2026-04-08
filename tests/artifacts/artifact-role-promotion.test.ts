// tests/artifacts/artifact-role-promotion.test.ts
// Unit tests for artifact role promotion helpers (Phase 5).
// Uses an in-memory Prisma-like stub — zero DB / network dependencies.

import {
  promoteArtifactsAfterApprove,
  discardPendingArtifacts,
  promoteOrphanArtifacts,
} from '@/lib/agents/runner'

// ─── In-memory stub ───────────────────────────────────────────────────────────

type ArtifactRow = {
  id: string
  run_id: string
  artifact_role: string
  created_at: Date
}

type RunRow = {
  id: string
  primary_artifact_id: string | null
}

/** Minimal in-memory DB that intercepts the Prisma calls made by the helpers. */
function makeStubDb(artifacts: ArtifactRow[], runs: RunRow[]) {
  return {
    runArtifact: {
      updateMany: jest.fn(
        async ({ where, data }: {
          where: { run_id: string; artifact_role: string }
          data: { artifact_role: string }
        }) => {
          let count = 0
          for (const a of artifacts) {
            if (a.run_id === where.run_id && a.artifact_role === where.artifact_role) {
              a.artifact_role = data.artifact_role
              count++
            }
          }
          return { count }
        },
      ),
      findFirst: jest.fn(
        async ({ where, orderBy, select }: {
          where: { run_id: string; artifact_role: string }
          orderBy: { created_at: 'asc' | 'desc' }
          select: { id: boolean }
        }) => {
          const matches = artifacts.filter(
            a => a.run_id === where.run_id && a.artifact_role === where.artifact_role,
          )
          if (matches.length === 0) return null
          matches.sort((a, b) =>
            orderBy.created_at === 'asc'
              ? a.created_at.getTime() - b.created_at.getTime()
              : b.created_at.getTime() - a.created_at.getTime(),
          )
          return select.id ? { id: matches[0]!.id } : matches[0]!
        },
      ),
    },
    run: {
      update: jest.fn(
        async ({ where, data }: {
          where: { id: string }
          data: { primary_artifact_id?: string }
        }) => {
          const run = runs.find(r => r.id === where.id)
          if (run && data.primary_artifact_id !== undefined) {
            run.primary_artifact_id = data.primary_artifact_id
          }
        },
      ),
    },
  }
}

// ─── Module-level mock of @/lib/db/client ────────────────────────────────────

// Named with 'mock' prefix so Jest's factory scope restriction permits the reference.
let mockStubDb: ReturnType<typeof makeStubDb>

jest.mock('@/lib/db/client', () => ({
  get db() { return mockStubDb },
}))

// Also stub the event bus so runner.ts doesn't crash on import
jest.mock('@/lib/events/project-event-bus.factory', () => ({
  projectEventBus: { emit: jest.fn() },
}))

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeArtifact(id: string, runId: string, role: string, offsetMs = 0): ArtifactRow {
  return {
    id,
    run_id: runId,
    artifact_role: role,
    created_at: new Date(1000 + offsetMs),
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('promoteArtifactsAfterApprove (REVIEWER APPROVE)', () => {
  it('promotes pending_review artifacts to primary and sets primary_artifact_id', async () => {
    const RUN_ID = 'run-approve-001'
    const artifacts: ArtifactRow[] = [
      makeArtifact('art-1', RUN_ID, 'pending_review', 0),
      makeArtifact('art-2', RUN_ID, 'pending_review', 100),
      makeArtifact('art-3', RUN_ID, 'supplementary', 200),
    ]
    const runs: RunRow[] = [{ id: RUN_ID, primary_artifact_id: null }]
    mockStubDb = makeStubDb(artifacts, runs) as ReturnType<typeof makeStubDb>

    await promoteArtifactsAfterApprove(RUN_ID)

    // Both pending_review artifacts should now be primary
    expect(artifacts[0]!.artifact_role).toBe('primary')
    expect(artifacts[1]!.artifact_role).toBe('primary')
    // supplementary untouched
    expect(artifacts[2]!.artifact_role).toBe('supplementary')

    // primary_artifact_id should point to the oldest primary artifact
    expect(runs[0]!.primary_artifact_id).toBe('art-1')
  })

  it('is a no-op when no pending_review artifacts exist', async () => {
    const RUN_ID = 'run-approve-002'
    const artifacts: ArtifactRow[] = [
      makeArtifact('art-1', RUN_ID, 'primary', 0),
    ]
    const runs: RunRow[] = [{ id: RUN_ID, primary_artifact_id: 'art-1' }]
    mockStubDb = makeStubDb(artifacts, runs) as ReturnType<typeof makeStubDb>

    await promoteArtifactsAfterApprove(RUN_ID)

    // No change
    expect(runs[0]!.primary_artifact_id).toBe('art-1')
    expect(mockStubDb.run.update).not.toHaveBeenCalled()
  })
})

describe('discardPendingArtifacts (REVIEWER REQUEST_REVISION)', () => {
  it('marks all pending_review artifacts as discarded', async () => {
    const RUN_ID = 'run-reject-001'
    const artifacts: ArtifactRow[] = [
      makeArtifact('art-1', RUN_ID, 'pending_review', 0),
      makeArtifact('art-2', RUN_ID, 'pending_review', 100),
      makeArtifact('art-3', RUN_ID, 'supplementary', 200),
    ]
    const runs: RunRow[] = [{ id: RUN_ID, primary_artifact_id: null }]
    mockStubDb = makeStubDb(artifacts, runs) as ReturnType<typeof makeStubDb>

    await discardPendingArtifacts(RUN_ID)

    expect(artifacts[0]!.artifact_role).toBe('discarded')
    expect(artifacts[1]!.artifact_role).toBe('discarded')
    // supplementary untouched
    expect(artifacts[2]!.artifact_role).toBe('supplementary')
    // primary_artifact_id not changed
    expect(runs[0]!.primary_artifact_id).toBeNull()
  })

  it('is a no-op when no pending_review artifacts exist', async () => {
    const RUN_ID = 'run-reject-002'
    const artifacts: ArtifactRow[] = []
    const runs: RunRow[] = [{ id: RUN_ID, primary_artifact_id: null }]
    mockStubDb = makeStubDb(artifacts, runs) as ReturnType<typeof makeStubDb>

    await discardPendingArtifacts(RUN_ID)

    expect(mockStubDb.runArtifact.updateMany).toHaveBeenCalledWith({
      where: { run_id: RUN_ID, artifact_role: 'pending_review' },
      data:  { artifact_role: 'discarded' },
    })
  })
})

describe('promoteOrphanArtifacts (C4 — COMPLETED without REVIEWER)', () => {
  it('promotes pending_review to primary and sets primary_artifact_id', async () => {
    const RUN_ID = 'run-c4-001'
    const artifacts: ArtifactRow[] = [
      makeArtifact('art-a', RUN_ID, 'pending_review', 0),
      makeArtifact('art-b', RUN_ID, 'pending_review', 50),
    ]
    const runs: RunRow[] = [{ id: RUN_ID, primary_artifact_id: null }]
    mockStubDb = makeStubDb(artifacts, runs) as ReturnType<typeof makeStubDb>

    await promoteOrphanArtifacts(RUN_ID)

    expect(artifacts[0]!.artifact_role).toBe('primary')
    expect(artifacts[1]!.artifact_role).toBe('primary')
    expect(runs[0]!.primary_artifact_id).toBe('art-a')
  })

  it('does not change primary_artifact_id when nothing to promote', async () => {
    const RUN_ID = 'run-c4-002'
    const artifacts: ArtifactRow[] = [makeArtifact('art-1', RUN_ID, 'primary', 0)]
    const runs: RunRow[] = [{ id: RUN_ID, primary_artifact_id: 'art-1' }]
    mockStubDb = makeStubDb(artifacts, runs) as ReturnType<typeof makeStubDb>

    await promoteOrphanArtifacts(RUN_ID)

    expect(runs[0]!.primary_artifact_id).toBe('art-1')
    expect(mockStubDb.run.update).not.toHaveBeenCalled()
  })
})
