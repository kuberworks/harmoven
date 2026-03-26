// app/demo/rbac/page.tsx
// RBAC Demo Page — 3 built-in roles: Viewer, Developer, Admin
// Validation checkpoint: T2B.1 Amendment 78
//
// Server Component — no Tailwind required (inline styles).
// Accessible at: http://localhost:3000/demo/rbac
//
// ⚠ DEVELOPMENT ONLY — disable this route in production.

import { BUILT_IN_ROLES, BUILT_IN_ROLE_DISPLAY_NAMES } from '@/lib/auth/built-in-roles'
import type { Permission } from '@/lib/auth/permissions'

// Guard: only render in non-production environments
export const dynamic = 'force-static'

// ─── Types ───────────────────────────────────────────────────────────────────

const DEMO_ROLES = ['viewer', 'developer', 'admin'] as const
type DemoRole = typeof DEMO_ROLES[number]

const PERM_GROUPS: { label: string; emoji: string; perms: Permission[] }[] = [
  {
    label: 'Runs', emoji: '▶',
    perms: ['runs:create', 'runs:read', 'runs:read_costs', 'runs:abort', 'runs:replay', 'runs:inject', 'runs:pause'],
  },
  {
    label: 'Gates', emoji: '🚦',
    perms: ['gates:read', 'gates:approve', 'gates:read_code', 'gates:read_critical'],
  },
  {
    label: 'Project', emoji: '📁',
    perms: ['project:read', 'project:edit', 'project:members', 'project:credentials'],
  },
  {
    label: 'Streams', emoji: '📡',
    perms: ['stream:state', 'stream:gates', 'stream:costs', 'stream:project'],
  },
  {
    label: 'Marketplace', emoji: '🛒',
    perms: ['marketplace:install'],
  },
  {
    label: 'Admin', emoji: '⚙️',
    perms: ['admin:models', 'admin:skills', 'admin:users', 'admin:triggers', 'admin:audit', 'admin:instance'],
  },
]

const ROLE_COLOURS: Record<DemoRole, { bg: string; border: string; text: string; badge: string }> = {
  viewer:    { bg: '#1a1a2e', border: '#6366f1', text: '#a5b4fc', badge: '#312e81' },
  developer: { bg: '#1a2e1a', border: '#22c55e', text: '#86efac', badge: '#14532d' },
  admin:     { bg: '#2e1a1a', border: '#f59e0b', text: '#fcd34d', badge: '#78350f' },
}

// ─── Data (server-side, no DB) ───────────────────────────────────────────────

function buildPermSets(): Record<DemoRole, Set<Permission>> {
  return DEMO_ROLES.reduce<Record<DemoRole, Set<Permission>>>((acc, role) => {
    acc[role] = new Set(BUILT_IN_ROLES[role])
    return acc
  }, {} as Record<DemoRole, Set<Permission>>)
}

const CAPABILITY_EXAMPLES: { label: string; perms: Permission[]; notes: string }[] = [
  { label: 'View run output',         perms: ['runs:read'],                             notes: 'core read' },
  { label: 'Launch a new run',        perms: ['runs:create'],                           notes: 'user+ only' },
  { label: 'Abort a running run',     perms: ['runs:abort'],                            notes: 'user+ only' },
  { label: 'See run cost breakdown',  perms: ['runs:read_costs'],                       notes: 'user_with_costs+' },
  { label: 'Approve human gate',      perms: ['gates:approve'],                         notes: 'operator+' },
  { label: 'Read code diff in gate',  perms: ['gates:read_code'],                       notes: 'developer+' },
  { label: 'Read critical findings',  perms: ['gates:read_critical'],                   notes: 'operator+' },
  { label: 'Edit project config',     perms: ['project:edit'],                          notes: 'developer+' },
  { label: 'Manage team members',     perms: ['project:members'],                       notes: 'admin+' },
  { label: 'Manage API credentials',  perms: ['project:credentials'],                   notes: 'admin+' },
  { label: 'Create + track costs',    perms: ['runs:create', 'runs:read_costs'],         notes: 'multiple perms' },
  { label: 'Full gate workflow',      perms: ['gates:read', 'gates:read_code', 'gates:approve'], notes: 'multiple perms' },
]

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = {
  page: {
    fontFamily: 'ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace',
    background: '#0f0f0f',
    color: '#e5e7eb',
    minHeight: '100vh',
    padding: '2rem',
    fontSize: '14px',
    lineHeight: '1.6',
  } as React.CSSProperties,
  container: {
    maxWidth: '1100px',
    margin: '0 auto',
  } as React.CSSProperties,
  h1: {
    fontSize: '1.5rem',
    fontWeight: 700,
    color: '#f9fafb',
    margin: '0 0 0.25rem 0',
  } as React.CSSProperties,
  subtitle: {
    color: '#6b7280',
    fontSize: '0.85rem',
    marginBottom: '2rem',
  } as React.CSSProperties,
  section: {
    marginBottom: '2.5rem',
  } as React.CSSProperties,
  sectionTitle: {
    fontSize: '0.75rem',
    fontWeight: 600,
    letterSpacing: '0.1em',
    textTransform: 'uppercase' as const,
    color: '#9ca3af',
    marginBottom: '1rem',
    paddingBottom: '0.5rem',
    borderBottom: '1px solid #1f2937',
  } as React.CSSProperties,
  roleCards: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '1.25rem',
    marginBottom: '2rem',
  } as React.CSSProperties,
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '0.8rem',
  } as React.CSSProperties,
  th: {
    textAlign: 'left' as const,
    padding: '0.5rem 0.75rem',
    color: '#9ca3af',
    fontWeight: 500,
    borderBottom: '1px solid #1f2937',
    background: '#111',
  } as React.CSSProperties,
  thCenter: {
    textAlign: 'center' as const,
    padding: '0.5rem 0.75rem',
    color: '#9ca3af',
    fontWeight: 500,
    borderBottom: '1px solid #1f2937',
    background: '#111',
  } as React.CSSProperties,
  td: {
    padding: '0.4rem 0.75rem',
    borderBottom: '1px solid #1a1a1a',
    color: '#d1d5db',
  } as React.CSSProperties,
  tdCenter: {
    textAlign: 'center' as const,
    padding: '0.4rem 0.75rem',
    borderBottom: '1px solid #1a1a1a',
  } as React.CSSProperties,
  groupRow: {
    background: '#141414',
    color: '#6b7280',
    fontSize: '0.72rem',
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    padding: '0.3rem 0.75rem',
    borderBottom: '1px solid #1a1a1a',
  } as React.CSSProperties,
  badge: (color: string, bg: string): React.CSSProperties => ({
    display: 'inline-block',
    padding: '0.15rem 0.5rem',
    borderRadius: '4px',
    fontSize: '0.7rem',
    fontWeight: 600,
    color,
    background: bg,
  }),
  tick: {
    color: '#22c55e',
    fontWeight: 700,
    fontSize: '1rem',
  } as React.CSSProperties,
  cross: {
    color: '#374151',
    fontSize: '0.9rem',
  } as React.CSSProperties,
  apiKeyBox: {
    background: '#111',
    border: '1px solid #1f2937',
    borderRadius: '6px',
    padding: '0.75rem 1rem',
    fontSize: '0.78rem',
    color: '#6b7280',
    marginTop: '0.5rem',
  } as React.CSSProperties,
  keyVal: {
    color: '#fbbf24',
    fontFamily: 'inherit',
  } as React.CSSProperties,
  note: {
    background: '#1a1500',
    border: '1px solid #78350f',
    borderRadius: '6px',
    padding: '0.75rem 1rem',
    color: '#fcd34d',
    fontSize: '0.78rem',
    marginBottom: '2rem',
  } as React.CSSProperties,
}

// ─── Components ───────────────────────────────────────────────────────────────

function RoleCard({ role, permSet }: { role: DemoRole; permSet: Set<Permission> }) {
  const colours      = ROLE_COLOURS[role]
  const extendedFrom = role === 'viewer' ? null : role === 'developer' ? 'user_with_costs' : 'developer'
  const allPerms     = BUILT_IN_ROLES[role]
  const baseCount    = extendedFrom ? BUILT_IN_ROLES[extendedFrom as keyof typeof BUILT_IN_ROLES].length : 0
  const extraCount   = allPerms.length - baseCount

  return (
    <div style={{
      background: colours.bg,
      border: `1px solid ${colours.border}`,
      borderRadius: '8px',
      padding: '1.25rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <span style={s.badge(colours.text, colours.badge)}>
          {BUILT_IN_ROLE_DISPLAY_NAMES[role]}
        </span>
      </div>

      <div style={{ color: '#9ca3af', fontSize: '0.75rem', marginBottom: '0.75rem' }}>
        {extendedFrom ? (
          <>extends <span style={{ color: colours.text }}>{extendedFrom}</span> + {extraCount} more</>
        ) : (
          <>root role — no parent</>
        )}
      </div>

      <div style={{ fontSize: '0.85rem', fontWeight: 700, color: colours.text, marginBottom: '0.5rem' }}>
        {permSet.size} permissions
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: '0.25rem' }}>
        {[...permSet].map((perm) => {
          const isExtra = extendedFrom
            ? !BUILT_IN_ROLES[extendedFrom as keyof typeof BUILT_IN_ROLES].includes(perm)
            : false
          return (
            <span
              key={perm}
              style={{
                fontSize: '0.65rem',
                padding: '0.1rem 0.4rem',
                borderRadius: '3px',
                background: isExtra ? colours.badge : '#1f2937',
                color: isExtra ? colours.text : '#6b7280',
                border: isExtra ? `1px solid ${colours.border}55` : '1px solid transparent',
              }}
            >
              {perm}
            </span>
          )
        })}
      </div>
    </div>
  )
}

function PermMatrix({ permSets }: { permSets: Record<DemoRole, Set<Permission>> }) {
  return (
    <table style={s.table}>
      <thead>
        <tr>
          <th style={s.th}>Permission</th>
          {DEMO_ROLES.map((r) => (
            <th key={r} style={s.thCenter}>
              <span style={s.badge(ROLE_COLOURS[r].text, ROLE_COLOURS[r].badge)}>
                {BUILT_IN_ROLE_DISPLAY_NAMES[r]}
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {PERM_GROUPS.map((group) => (
          <>
            <tr key={`g-${group.label}`}>
              <td colSpan={4} style={s.groupRow}>
                {group.emoji} {group.label}
              </td>
            </tr>
            {group.perms.map((perm) => (
              <tr key={perm}>
                <td style={s.td}>{perm}</td>
                {DEMO_ROLES.map((role) => (
                  <td key={role} style={s.tdCenter}>
                    {permSets[role].has(perm)
                      ? <span style={s.tick}>✓</span>
                      : <span style={s.cross}>·</span>
                    }
                  </td>
                ))}
              </tr>
            ))}
          </>
        ))}
      </tbody>
    </table>
  )
}

function CapabilityTable({ permSets }: { permSets: Record<DemoRole, Set<Permission>> }) {
  return (
    <table style={s.table}>
      <thead>
        <tr>
          <th style={s.th}>Capability</th>
          <th style={{ ...s.th, color: '#6b7280', fontSize: '0.72rem' }}>Required perms</th>
          {DEMO_ROLES.map((r) => (
            <th key={r} style={s.thCenter}>
              <span style={s.badge(ROLE_COLOURS[r].text, ROLE_COLOURS[r].badge)}>
                {BUILT_IN_ROLE_DISPLAY_NAMES[r]}
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {CAPABILITY_EXAMPLES.map((check) => {
          const allowed = DEMO_ROLES.reduce<Record<DemoRole, boolean>>((acc, role) => {
            acc[role] = check.perms.every((p) => permSets[role].has(p))
            return acc
          }, {} as Record<DemoRole, boolean>)

          return (
            <tr key={check.label}>
              <td style={s.td}>{check.label}</td>
              <td style={{ ...s.td, color: '#4b5563', fontSize: '0.72rem' }}>
                {check.perms.join(', ')}
              </td>
              {DEMO_ROLES.map((role) => (
                <td key={role} style={s.tdCenter}>
                  {allowed[role]
                    ? <span style={s.tick} title="ALLOWED">✓</span>
                    : <span style={s.cross} title="DENIED (ForbiddenError)">–</span>
                  }
                </td>
              ))}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ─── Page component ───────────────────────────────────────────────────────────

export default function RbacDemoPage() {
  if (process.env.NODE_ENV === 'production') {
    return (
      <div style={{ ...s.page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#6b7280' }}>Demo not available in production.</p>
      </div>
    )
  }

  const permSets = buildPermSets()

  return (
    <div style={s.page}>
      <div style={s.container}>
        {/* Header */}
        <h1 style={s.h1}>RBAC Demo — 3 Built-in Roles</h1>
        <p style={s.subtitle}>
          Validation checkpoint T2B.1 · Amendment 78 · {new Date().toLocaleDateString('fr-FR')}
        </p>

        <div style={s.note}>
          ⚠ Development only — this page is hidden in production (NODE_ENV check).
          Run <code>npx tsx scripts/rbac-demo.ts</code> for the CLI version.
        </div>

        {/* Role Cards */}
        <div style={s.section}>
          <h2 style={s.sectionTitle}>The 3 Demo Roles</h2>
          <div style={s.roleCards}>
            {DEMO_ROLES.map((role) => (
              <RoleCard key={role} role={role} permSet={permSets[role]} />
            ))}
          </div>
        </div>

        {/* Permission Matrix */}
        <div style={s.section}>
          <h2 style={s.sectionTitle}>Permission Matrix (26 permissions)</h2>
          <PermMatrix permSets={permSets} />
        </div>

        {/* Capability / gating table */}
        <div style={s.section}>
          <h2 style={s.sectionTitle}>Access Control Gating — assertPermissions()</h2>
          <p style={{ color: '#6b7280', fontSize: '0.78rem', marginBottom: '1rem' }}>
            ✓ = ALLOWED (all required perms present)  ·  – = DENIED (ForbiddenError thrown)
          </p>
          <CapabilityTable permSets={permSets} />
        </div>

        {/* API key format */}
        <div style={s.section}>
          <h2 style={s.sectionTitle}>API Key Format — hv1_ + SHA-256 (Am.42.10)</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem' }}>
            {DEMO_ROLES.map((role) => (
              <div key={role} style={{
                background: '#111',
                border: `1px solid ${ROLE_COLOURS[role].border}55`,
                borderRadius: '6px',
                padding: '1rem',
              }}>
                <div style={{ fontSize: '0.72rem', fontWeight: 600, color: ROLE_COLOURS[role].text, marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  {BUILT_IN_ROLE_DISPLAY_NAMES[role]} key
                </div>
                <div style={{ fontSize: '0.72rem', color: '#4b5563', marginBottom: '0.25rem' }}>Format</div>
                <code style={{ ...s.keyVal, fontSize: '0.72rem' }}>hv1_&#x7b;32 hex chars&#x7d;</code>
                <div style={{ fontSize: '0.72rem', color: '#4b5563', marginTop: '0.5rem', marginBottom: '0.25rem' }}>Stored</div>
                <div style={{ fontSize: '0.72rem', color: '#6b7280' }}>SHA-256(raw_key) in key_hash</div>
                <div style={{ fontSize: '0.72rem', color: '#6b7280' }}>Raw key shown once · Never persisted</div>
                <div style={{ fontSize: '0.72rem', color: '#6b7280' }}>Compare via timingSafeEqual()</div>
                <div style={{ fontSize: '0.72rem', color: '#ef4444', marginTop: '0.5rem' }}>
                  ✗ instance_admin role blocked for API keys
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* API endpoints */}
        <div style={s.section}>
          <h2 style={s.sectionTitle}>API Endpoints (Am.78)</h2>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Endpoint</th>
                <th style={s.th}>Method</th>
                <th style={s.th}>Required Permission</th>
                <th style={s.th}>Description</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['POST /api/projects/:id/members',             'POST',   'project:members',     'Add member with role'],
                ['GET /api/projects/:id/members',              'GET',    'project:members',     'List members'],
                ['PATCH /api/projects/:id/members/:userId',    'PATCH',  'project:members',     'Change member role'],
                ['DELETE /api/projects/:id/members/:userId',   'DELETE', 'project:members',     'Remove member'],
                ['GET /api/projects/:id/roles',                'GET',    'project:members',     'List built-in + custom roles'],
                ['POST /api/projects/:id/roles',               'POST',   'project:members',     'Create custom role'],
                ['PATCH /api/projects/:id/roles/:roleId',      'PATCH',  'project:members',     'Update custom role'],
                ['DELETE /api/projects/:id/roles/:roleId',     'DELETE', 'project:members',     'Delete custom role'],
                ['GET /api/projects/:id/api-keys',             'GET',    'project:credentials', 'List keys (no hash)'],
                ['POST /api/projects/:id/api-keys',            'POST',   'project:credentials', 'Create key (raw shown once)'],
                ['DELETE /api/projects/:id/api-keys/:keyId',   'DELETE', 'project:credentials', 'Revoke key'],
              ].map(([path, method, perm, desc]) => (
                <tr key={path}>
                  <td style={{ ...s.td, fontFamily: 'inherit', color: '#93c5fd' }}>{path}</td>
                  <td style={{ ...s.td, color: '#a5f3fc' }}>{method}</td>
                  <td style={{ ...s.td, color: '#fcd34d' }}>{perm}</td>
                  <td style={{ ...s.td, color: '#6b7280' }}>{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div style={{ borderTop: '1px solid #1f2937', paddingTop: '1rem', color: '#374151', fontSize: '0.72rem' }}>
          T2B.1 feat/t2b1-rbac · merged to develop · 252 tests passing · score 4.2/5
        </div>
      </div>
    </div>
  )
}
