// app/api/updates/route.ts
// GET /api/updates — Check for available Harmoven updates.
//
// Returns the current version, latest version, bump type, and migration preview.
// Reserved for instance_admin — this is instance-level information.
//
// Spec: Amendment 88 (Docker update flow), Am.91.6 (update integrity).
//
// Security:
//   - assertInstanceAdmin() enforced — project admins cannot access
//   - Network calls go to Docker Hub (public) and GitHub API (public) only
//   - All registry responses are validated via Zod before use (in version-check.ts)

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller }            from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, UnauthorizedError, ForbiddenError } from '@/lib/auth/rbac'
import { checkForUpdates }          from '@/lib/updates/version-check'
import { generateMigrationPreview } from '@/lib/updates/migration-preview'

export async function GET(req: NextRequest) {
  // Auth guard
  const caller = await resolveCaller(req)
  if (!caller) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    assertInstanceAdmin(caller)
  } catch (e) {
    const status = (e instanceof UnauthorizedError) ? 401 : 403
    return NextResponse.json(
      { error: status === 401 ? 'Unauthorized' : 'Forbidden' },
      { status },
    )
  }

  // Run version check and migration preview in parallel
  const [updateResult, migrationPreview] = await Promise.all([
    checkForUpdates(),
    generateMigrationPreview(),
  ])

  return NextResponse.json({
    ...updateResult,
    migrationPreview,
  })
}
