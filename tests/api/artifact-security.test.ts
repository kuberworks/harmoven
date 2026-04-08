// tests/api/artifact-security.test.ts
// Security tests for GET /api/runs/:runId/artifacts/:artifactId
// Verifies S1 (Content-Disposition attachment, Content-Type octet-stream)
// and S3 (discarded artifacts → 404).

import { NextRequest } from 'next/server'

// ─── Mocks ────────────────────────────────────────────────────────────────────
// jest.mock is hoisted — factories must not reference const/let from outer scope.
// Access mocked functions via require() after jest.mock declarations.

jest.mock('@/lib/auth/resolve-caller', () => ({
  resolveCaller: jest.fn(),
}))

jest.mock('@/lib/db/client', () => ({
  db: {
    runArtifact: {
      findUnique: jest.fn(),
    },
  },
}))

jest.mock('@/lib/auth/ownership', () => ({
  assertProjectAccess: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/lib/auth/rbac', () => ({
  resolvePermissions: jest.fn().mockResolvedValue(new Set(['runs:read'])),
  ForbiddenError:     class ForbiddenError extends Error {},
  UnauthorizedError:  class UnauthorizedError extends Error {},
}))

// ─── Import handler after mocks ───────────────────────────────────────────────

import { GET } from '@/app/api/runs/[runId]/artifacts/[artifactId]/route'

// Access mocked functions
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveCaller } = require('@/lib/auth/resolve-caller') as { resolveCaller: jest.Mock }
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { db } = require('@/lib/db/client') as { db: { runArtifact: { findUnique: jest.Mock } } }

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_ARTIFACT = {
  id:         'art-001',
  run_id:     'run-001',
  node_id:    'n1',
  filename:   'report.csv',
  mime_type:  'text/csv',
  size_bytes: 42,
  data:       Buffer.from('hello,world'),
  created_at: new Date(),
  expires_at: new Date(Date.now() + 86400_000),
  run:        { project_id: 'proj-001' },
}

function makeRequest(runId: string, artifactId: string): NextRequest {
  return new NextRequest(`http://localhost/api/runs/${runId}/artifacts/${artifactId}`)
}

function makeParams(runId: string, artifactId: string) {
  return { params: Promise.resolve({ runId, artifactId }) }
}

describe('GET /api/runs/:runId/artifacts/:artifactId', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resolveCaller.mockResolvedValue({ id: 'user-001', role: 'USER' })
    db.runArtifact.findUnique.mockResolvedValue(BASE_ARTIFACT)
  })

  describe('S1 — Content-Disposition and Content-Type headers', () => {
    it('always returns Content-Disposition: attachment', async () => {
      const res = await GET(makeRequest('run-001', 'art-001'), makeParams('run-001', 'art-001'))
      const disposition = res.headers.get('Content-Disposition')
      expect(disposition).toBeDefined()
      expect(disposition).toMatch(/^attachment/)
    })

    it('always returns Content-Type: application/octet-stream', async () => {
      const res = await GET(makeRequest('run-001', 'art-001'), makeParams('run-001', 'art-001'))
      expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
    })

    it('never uses the stored mime_type (text/csv) as Content-Type', async () => {
      const res = await GET(makeRequest('run-001', 'art-001'), makeParams('run-001', 'art-001'))
      expect(res.headers.get('Content-Type')).not.toBe('text/csv')
    })

    it('includes X-Content-Type-Options: nosniff', async () => {
      const res = await GET(makeRequest('run-001', 'art-001'), makeParams('run-001', 'art-001'))
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    })

    it('includes Cache-Control: private, no-store', async () => {
      const res = await GET(makeRequest('run-001', 'art-001'), makeParams('run-001', 'art-001'))
      expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    })

    it('encodes filename with RFC 5987 UTF-8 encoding', async () => {
      db.runArtifact.findUnique.mockResolvedValue({ ...BASE_ARTIFACT, filename: 'rapport résumé.csv' })
      const res = await GET(makeRequest('run-001', 'art-001'), makeParams('run-001', 'art-001'))
      const disposition = res.headers.get('Content-Disposition') ?? ''
      expect(disposition).toMatch(/filename\*=UTF-8''/)
    })
  })

  describe('S3 — discarded artifacts return 404', () => {
    it('returns 404 for artifact_role = discarded', async () => {
      db.runArtifact.findUnique.mockResolvedValue({ ...BASE_ARTIFACT, artifact_role: 'discarded' })
      const res = await GET(makeRequest('run-001', 'art-001'), makeParams('run-001', 'art-001'))
      expect(res.status).toBe(404)
    })

    it('returns 200 for artifact_role = primary', async () => {
      db.runArtifact.findUnique.mockResolvedValue({ ...BASE_ARTIFACT, artifact_role: 'primary' })
      const res = await GET(makeRequest('run-001', 'art-001'), makeParams('run-001', 'art-001'))
      expect(res.status).toBe(200)
    })

    it('returns 200 for artifact_role = pending_review (default)', async () => {
      db.runArtifact.findUnique.mockResolvedValue({ ...BASE_ARTIFACT, artifact_role: 'pending_review' })
      const res = await GET(makeRequest('run-001', 'art-001'), makeParams('run-001', 'art-001'))
      expect(res.status).toBe(200)
    })

    it('returns 200 when artifact_role field is absent (pre-MF-Phase1 migration)', async () => {
      // Simulate pre-MF-Phase1 state where the column doesn't exist
      db.runArtifact.findUnique.mockResolvedValue({ ...BASE_ARTIFACT })
      const res = await GET(makeRequest('run-001', 'art-001'), makeParams('run-001', 'art-001'))
      expect(res.status).toBe(200)
    })
  })

  describe('Auth / IDOR checks', () => {
    it('returns 401 when caller is null', async () => {
      resolveCaller.mockResolvedValue(null)
      const res = await GET(makeRequest('run-001', 'art-001'), makeParams('run-001', 'art-001'))
      expect(res.status).toBe(401)
    })

    it('returns 404 when artifact not found', async () => {
      db.runArtifact.findUnique.mockResolvedValue(null)
      const res = await GET(makeRequest('run-001', 'art-001'), makeParams('run-001', 'art-001'))
      expect(res.status).toBe(404)
    })

    it('returns 404 when run_id does not match URL (IDOR protection)', async () => {
      const res = await GET(makeRequest('different-run', 'art-001'), makeParams('different-run', 'art-001'))
      // artifact.run_id = 'run-001', URL has 'different-run'
      expect(res.status).toBe(404)
    })
  })
})

