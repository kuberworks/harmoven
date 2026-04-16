// lib/auth/data-export.ts
// RGPD Art.20 — Right to data portability.
// Collects all personal data for a given user and returns it as a structured
// JSON-serialisable object ready to be delivered as a downloadable export.
//
// Design decisions:
//  - Only data the user *provided* is included (Art.20 scope).
//    Derived/analytical data (AnalyticsEvent, AuditLog) is included as
//    "activity log" — it is de facto personal data the platform holds about
//    the user, even if not submitted by them.
//  - API key *hashes* are excluded; only metadata (name, prefix, created_at)
//    is exported. Exporting a hash would be useless and create confusion.
//  - Credential *values* (encrypted secrets) are excluded — they belong to
//    third-party services, not the user's personal data in the RGPD sense.
//  - Run node-level data (Node table) is excluded: it is execution artefact
//    data, not personal data authored by the user.
//  - The export envelope carries a generated_at timestamp and schema_version
//    so future consumers can detect format changes.

import { db }                    from '@/lib/db/client'
import { EXCLUDE_PHANTOM_RUNS }  from '@/lib/db/run-filters'

export const DATA_EXPORT_SCHEMA_VERSION = '1.0'

export interface UserDataExport {
  schema_version: string
  generated_at:   string   // ISO 8601
  user: {
    id:              string
    name:            string
    email:           string
    created_at:      string
    ui_level:        string
    expert_mode:     boolean
    ui_locale:       string | null
  }
  projects:             ProjectExport[]
  project_memberships:  MembershipExport[]
  pipeline_templates:   TemplateExport[]
  runs:                 RunExport[]
  installed_packs:      PackExport[]
  user_preferences:     PreferenceExport[]
  api_keys:             ApiKeyExport[]
  audit_activity:       AuditExport[]
}

interface ProjectExport {
  id:         string
  name:       string
  created_at: string
}

interface MembershipExport {
  project_id: string
  role_id:    string
  added_at:   string
}

interface TemplateExport {
  id:          string
  name:        string
  description: string | null
  is_public:   boolean
  created_at:  string
  version_count: number
}

interface RunExport {
  id:         string
  project_id: string
  status:     string
  created_at: string
}

interface PackExport {
  pack_id:      string
  source:       string
  version:      string
  installed_at: string
}

interface PreferenceExport {
  project_id:  string | null
  preference:  string
  evidence:    string
  confidence:  string
  applied_at:  string
}

interface ApiKeyExport {
  id:         string
  name:       string | null
  prefix:     string | null
  created_at: string
  expires_at: string | null
}

interface AuditExport {
  id:          string
  action_type: string
  timestamp:   string
  payload:     unknown
}

export async function buildUserDataExport(userId: string): Promise<UserDataExport> {
  const [
    user,
    projects,
    memberships,
    templates,
    runs,
    packs,
    preferences,
    apiKeys,
    auditLogs,
  ] = await Promise.all([
    db.user.findUniqueOrThrow({
      where:  { id: userId },
      select: {
        id:          true,
        name:        true,
        email:       true,
        createdAt:   true,
        ui_level:    true,
        expert_mode: true,
        ui_locale:   true,
      },
    }),

    db.project.findMany({
      where:  { created_by: userId },
      select: { id: true, name: true, created_at: true },
      orderBy: { created_at: 'asc' },
    }),

    db.projectMember.findMany({
      where:   { user_id: userId },
      select:  { project_id: true, role_id: true, added_at: true },
      orderBy: { added_at: 'asc' },
    }),

    db.pipelineTemplate.findMany({
      where:   { created_by: userId },
      select:  {
        id:          true,
        name:        true,
        description: true,
        is_public:   true,
        created_at:  true,
        _count:      { select: { versions: true } },
      },
      orderBy: { created_at: 'asc' },
    }),

    db.run.findMany({
      where:   { created_by: userId, ...EXCLUDE_PHANTOM_RUNS },
      select:  { id: true, project_id: true, status: true, created_at: true },
      orderBy: { created_at: 'asc' },
    }),

    db.installedPack.findMany({
      where:   { user_id: userId },
      select:  { pack_id: true, source: true, version: true, installed_at: true },
      orderBy: { installed_at: 'asc' },
    }),

    db.userPreference.findMany({
      where:   { user_id: userId },
      select:  { project_id: true, preference: true, evidence: true, confidence: true, applied_at: true },
      orderBy: { applied_at: 'asc' },
    }),

    // BetterAuthApiKey — only metadata, no hash
    db.betterAuthApiKey.findMany({
      where:   { userId },
      select:  { id: true, name: true, prefix: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: 'asc' },
    }),

    // Activity: audit entries where this user triggered the action
    db.auditLog.findMany({
      where:   { actor: userId },
      select:  { id: true, action_type: true, timestamp: true, payload: true },
      orderBy: { timestamp: 'asc' },
    }),
  ])

  return {
    schema_version: DATA_EXPORT_SCHEMA_VERSION,
    generated_at:   new Date().toISOString(),

    user: {
      id:          user.id,
      name:        user.name,
      email:       user.email,
      created_at:  user.createdAt.toISOString(),
      ui_level:    user.ui_level,
      expert_mode: user.expert_mode,
      ui_locale:   user.ui_locale,
    },

    projects: projects.map(p => ({
      id:         p.id,
      name:       p.name,
      created_at: p.created_at.toISOString(),
    })),

    project_memberships: memberships.map(m => ({
      project_id: m.project_id,
      role_id:    m.role_id,
      added_at:   m.added_at.toISOString(),
    })),

    pipeline_templates: templates.map(t => ({
      id:            t.id,
      name:          t.name,
      description:   t.description,
      is_public:     t.is_public,
      created_at:    t.created_at.toISOString(),
      version_count: t._count.versions,
    })),

    runs: runs.map(r => ({
      id:         r.id,
      project_id: r.project_id,
      status:     r.status,
      created_at: r.created_at.toISOString(),
    })),

    installed_packs: packs.map(p => ({
      pack_id:      p.pack_id,
      source:       p.source,
      version:      p.version,
      installed_at: p.installed_at.toISOString(),
    })),

    user_preferences: preferences.map(p => ({
      project_id: p.project_id,
      preference: p.preference,
      evidence:   p.evidence,
      confidence: p.confidence.toString(),
      applied_at: p.applied_at.toISOString(),
    })),

    api_keys: apiKeys.map(k => ({
      id:         k.id,
      name:       k.name,
      prefix:     k.prefix,
      created_at: k.createdAt.toISOString(),
      expires_at: k.expiresAt?.toISOString() ?? null,
    })),

    audit_activity: auditLogs.map(a => ({
      id:          a.id,
      action_type: a.action_type,
      timestamp:   a.timestamp.toISOString(),
      payload:     a.payload,
    })),
  }
}
