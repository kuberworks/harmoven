// tests/auth/data-export.test.ts
// Unit tests for lib/auth/data-export — RGPD Art.20 data portability.

import { jest, describe, it, expect, beforeEach } from '@jest/globals'

// ─── Mock DB client ───────────────────────────────────────────────────────────

const mockUserFindUniqueOrThrow    = jest.fn<() => Promise<unknown>>()
const mockProjectFindMany          = jest.fn<() => Promise<unknown[]>>()
const mockProjectMemberFindMany    = jest.fn<() => Promise<unknown[]>>()
const mockPipelineTemplateFindMany = jest.fn<() => Promise<unknown[]>>()
const mockRunFindMany              = jest.fn<() => Promise<unknown[]>>()
const mockInstalledPackFindMany    = jest.fn<() => Promise<unknown[]>>()
const mockUserPreferenceFindMany   = jest.fn<() => Promise<unknown[]>>()
const mockApiKeyFindMany           = jest.fn<() => Promise<unknown[]>>()
const mockAuditLogFindMany         = jest.fn<() => Promise<unknown[]>>()

jest.mock('@/lib/db/client', () => ({
  db: new Proxy({}, {
    get: (_: object, prop: string) => {
      if (prop === 'user')             return { findUniqueOrThrow: mockUserFindUniqueOrThrow }
      if (prop === 'project')          return { findMany: mockProjectFindMany }
      if (prop === 'projectMember')    return { findMany: mockProjectMemberFindMany }
      if (prop === 'pipelineTemplate') return { findMany: mockPipelineTemplateFindMany }
      if (prop === 'run')              return { findMany: mockRunFindMany }
      if (prop === 'installedPack')    return { findMany: mockInstalledPackFindMany }
      if (prop === 'userPreference')   return { findMany: mockUserPreferenceFindMany }
      if (prop === 'betterAuthApiKey') return { findMany: mockApiKeyFindMany }
      if (prop === 'auditLog')         return { findMany: mockAuditLogFindMany }
      return {}
    },
  }),
}))

import { buildUserDataExport, DATA_EXPORT_SCHEMA_VERSION } from '@/lib/auth/data-export'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date('2026-03-29T12:00:00.000Z')

const STUB_USER = {
  id:          'user-1',
  name:        'Alice Dupont',
  email:       'alice@example.com',
  createdAt:   NOW,
  ui_level:    'STANDARD',
  expert_mode: false,
  ui_locale:   'fr',
}

function setupEmptyUser() {
  mockUserFindUniqueOrThrow.mockResolvedValue(STUB_USER)
  mockProjectFindMany.mockResolvedValue([])
  mockProjectMemberFindMany.mockResolvedValue([])
  mockPipelineTemplateFindMany.mockResolvedValue([])
  mockRunFindMany.mockResolvedValue([])
  mockInstalledPackFindMany.mockResolvedValue([])
  mockUserPreferenceFindMany.mockResolvedValue([])
  mockApiKeyFindMany.mockResolvedValue([])
  mockAuditLogFindMany.mockResolvedValue([])
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildUserDataExport()', () => {
  beforeEach(() => { jest.clearAllMocks() })

  it('returns the correct schema_version', async () => {
    setupEmptyUser()
    const result = await buildUserDataExport('user-1')
    expect(result.schema_version).toBe(DATA_EXPORT_SCHEMA_VERSION)
  })

  it('includes a generated_at ISO timestamp', async () => {
    setupEmptyUser()
    const before = Date.now()
    const result = await buildUserDataExport('user-1')
    const after  = Date.now()
    const ts     = new Date(result.generated_at).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('maps user profile fields correctly', async () => {
    setupEmptyUser()
    const result = await buildUserDataExport('user-1')

    expect(result.user).toMatchObject({
      id:          'user-1',
      name:        'Alice Dupont',
      email:       'alice@example.com',
      ui_level:    'STANDARD',
      expert_mode: false,
      ui_locale:   'fr',
      created_at:  NOW.toISOString(),
    })
  })

  it('returns empty arrays when user has no data', async () => {
    setupEmptyUser()
    const result = await buildUserDataExport('user-1')

    expect(result.projects).toHaveLength(0)
    expect(result.project_memberships).toHaveLength(0)
    expect(result.pipeline_templates).toHaveLength(0)
    expect(result.runs).toHaveLength(0)
    expect(result.installed_packs).toHaveLength(0)
    expect(result.user_preferences).toHaveLength(0)
    expect(result.api_keys).toHaveLength(0)
    expect(result.audit_activity).toHaveLength(0)
  })

  it('maps projects correctly', async () => {
    setupEmptyUser()
    mockProjectFindMany.mockResolvedValue([
      { id: 'proj-1', name: 'Mon Projet', created_at: NOW },
    ])

    const result = await buildUserDataExport('user-1')
    expect(result.projects).toEqual([
      { id: 'proj-1', name: 'Mon Projet', created_at: NOW.toISOString() },
    ])
  })

  it('maps pipeline_templates with version_count', async () => {
    setupEmptyUser()
    mockPipelineTemplateFindMany.mockResolvedValue([
      {
        id:          'tpl-1',
        name:        'My Pipeline',
        description: null,
        is_public:   false,
        created_at:  NOW,
        _count:      { versions: 3 },
      },
    ])

    const result = await buildUserDataExport('user-1')
    expect(result.pipeline_templates[0]).toMatchObject({
      id:            'tpl-1',
      version_count: 3,
      created_at:    NOW.toISOString(),
    })
  })

  it('maps project_memberships with role_id and added_at', async () => {
    setupEmptyUser()
    mockProjectMemberFindMany.mockResolvedValue([
      { project_id: 'proj-1', role_id: 'role-viewer', added_at: NOW },
    ])

    const result = await buildUserDataExport('user-1')
    expect(result.project_memberships[0]).toMatchObject({
      project_id: 'proj-1',
      role_id:    'role-viewer',
      added_at:   NOW.toISOString(),
    })
  })

  it('maps api_keys without exposing the hash', async () => {
    setupEmptyUser()
    mockApiKeyFindMany.mockResolvedValue([
      {
        id:        'key-1',
        name:      'CI Key',
        prefix:    'hv1_',
        createdAt: NOW,
        expiresAt: null,
      },
    ])

    const result = await buildUserDataExport('user-1')
    expect(result.api_keys[0]).toEqual({
      id:         'key-1',
      name:       'CI Key',
      prefix:     'hv1_',
      created_at: NOW.toISOString(),
      expires_at: null,
    })
    // Ensure the hash field is not present
    expect(result.api_keys[0]).not.toHaveProperty('key')
  })

  it('maps user_preferences with confidence as string', async () => {
    setupEmptyUser()
    const confidence = { toString: () => '0.85' }
    mockUserPreferenceFindMany.mockResolvedValue([
      { project_id: null, preference: 'no_tables', evidence: 'user said so', confidence, applied_at: NOW },
    ])

    const result = await buildUserDataExport('user-1')
    expect(result.user_preferences[0]).toMatchObject({
      preference: 'no_tables',
      confidence: '0.85',
    })
  })

  it('maps audit_activity with payload', async () => {
    setupEmptyUser()
    mockAuditLogFindMany.mockResolvedValue([
      { id: 'audit-1', action_type: 'project.created', timestamp: NOW, payload: { project_id: 'proj-1' } },
    ])

    const result = await buildUserDataExport('user-1')
    expect(result.audit_activity[0]).toMatchObject({
      id:          'audit-1',
      action_type: 'project.created',
      payload:     { project_id: 'proj-1' },
    })
  })

  it('fetches data with userId passed to all queries', async () => {
    setupEmptyUser()
    await buildUserDataExport('user-42')

    expect(mockUserFindUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user-42' } }),
    )
    expect(mockProjectFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { created_by: 'user-42' } }),
    )
    expect(mockProjectMemberFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user_id: 'user-42' } }),
    )
    // EXCLUDE_PHANTOM_RUNS spreads a NOT clause into the where object;
    // use nested objectContaining so the assertion stays resilient to future filter additions.
    expect(mockRunFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ created_by: 'user-42' }) }),
    )
    expect(mockAuditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { actor: 'user-42' } }),
    )
  })
})
