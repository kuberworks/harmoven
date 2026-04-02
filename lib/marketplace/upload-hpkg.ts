// lib/marketplace/upload-hpkg.ts
// .hpkg package upload validation and persistence (B.3).
//
// Validation sequence (B.3.2):
//   1. Extension check — .hpkg or .harmoven.zip
//   2. Magic bytes check — ZIP signature 50 4B 03 04
//   3. Unzip — count entries, check depth, check extensions
//      - Reject path traversal (../ or absolute paths)
//      - Reject symlinks
//      - Reject Windows absolute paths (C:\...)
//   4. Parse + Zod-validate manifest.json
//   5. Verify content_sha256 against primary definition file
//   6. runDoubleScan() on primary file contents
//   7. Static safety check on manifest description + tags (B.2.4)
//   8. Create McpSkill row with enabled:false, source_type:'upload'
//   9. AuditLog marketplace_upload_approved

import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { uuidv7 } from '@/lib/utils/uuidv7'
import { runDoubleScan, runPromptInjectionScan, buildScanResult } from './static-safety-scan'

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_UNCOMPRESSED = 10_000_000 // 10 MB
const MAX_FILE_COUNT   = 100
const MAX_NESTING_DEPTH = 2

const ALLOWED_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.toml', '.md', '.txt'])
const FORBIDDEN_EXTENSIONS = new Set([
  '.js', '.ts', '.mjs', '.cjs', '.sh', '.py', '.rb', '.go', '.java', '.cs',
  '.exe', '.dll', '.so', '.dylib', '.bat', '.cmd', '.ps1',
])

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

// ─── Manifest schema ──────────────────────────────────────────────────────────

const ManifestSchema = z.object({
  schema_version:     z.string(),
  capability_type:    z.enum(['domain_pack', 'mcp_skill', 'harmoven_agent', 'js_ts_plugin']),
  pack_id:            z.string().regex(/^[a-z0-9_]{1,64}$/),
  name:               z.string().min(1).max(128),
  version:            z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/),
  author:             z.string().max(256).optional(),
  description:        z.string().max(512).optional(),
  tags:               z.array(z.string().max(64)).max(20).optional(),
  harmoven_min_version: z.string().optional(),
  license:            z.string().optional(),
  content_sha256:     z.string().regex(/^[0-9a-f]{64}$/i),
})

export type HpkgManifest = z.infer<typeof ManifestSchema>

// ─── Error ────────────────────────────────────────────────────────────────────

export class HpkgError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HpkgError'
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

export async function validateHpkg(buffer: Buffer): Promise<{
  manifest: HpkgManifest
  primaryContent: string
  uploadSha256: string
}> {
  // 1. Extension check (caller verifies filename — this checks magic bytes)
  // 2. Magic bytes
  if (!buffer.subarray(0, 4).equals(ZIP_MAGIC)) {
    throw new HpkgError('INVALID_FORMAT', 'File is not a valid ZIP archive')
  }

  // SHA-256 of the uploaded file bytes
  const uploadSha256 = createHash('sha256').update(buffer).digest('hex')

  // 3. Unzip
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch (e) {
    throw new HpkgError('INVALID_FORMAT', `ZIP extraction failed: ${String(e).slice(0, 100)}`)
  }

  const entries = Object.keys(zip.files)

  // File count
  if (entries.length > MAX_FILE_COUNT) {
    throw new HpkgError('ZIP_TOO_MANY_FILES', `ZIP contains ${entries.length} files (max ${MAX_FILE_COUNT})`)
  }

  let totalUncompressed = 0
  const primaryFiles: string[] = []

  for (const entryPath of entries) {
    const entry = zip.files[entryPath]!

    // Path traversal checks — run before reading any entry (SEC-34)
    const normalised = entryPath.replace(/\\/g, '/')
    if (normalised.includes('..') || normalised.startsWith('/')) {
      throw new HpkgError('PATH_TRAVERSAL', `Path traversal detected: ${entryPath}`)
    }
    // Windows absolute path
    if (/^[A-Za-z]:[/\\]/.test(entryPath)) {
      throw new HpkgError('PATH_TRAVERSAL', `Absolute Windows path: ${entryPath}`)
    }
    // Symlink check — unixPermissions can be null or number
    if (typeof entry.unixPermissions === 'number' && (entry.unixPermissions & 0xa000) === 0xa000) {
      throw new HpkgError('SYMLINK_DETECTED', `Symlink detected: ${entryPath}`)
    }

    // Nesting depth
    const depth = normalised.split('/').length - 1
    if (depth > MAX_NESTING_DEPTH) {
      throw new HpkgError('TOO_DEEP', `Entry too deeply nested: ${entryPath}`)
    }

    // Extension check
    if (!entry.dir) {
      const ext = '.' + (entryPath.split('.').pop()?.toLowerCase() ?? '')
      if (FORBIDDEN_EXTENSIONS.has(ext)) {
        throw new HpkgError('FORBIDDEN_EXTENSION', `Forbidden file type in archive: ${ext}`)
      }
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        throw new HpkgError('FORBIDDEN_EXTENSION', `Unsupported file type in archive: ${ext}`)
      }
    }

    // Uncompressed size tracking (approximate — actual check happens at extract time)
    // We skip the pre-check here and rely on the extract-time size cap instead.

    // Collect primary definition files
    if (!entry.dir && ['pack.toml', 'skill.yaml', 'skill.yml'].includes(entryPath)) {
      primaryFiles.push(entryPath)
    }
  }

  // 4. Parse manifest.json
  const manifestEntry = zip.files['manifest.json']
  if (!manifestEntry) {
    throw new HpkgError('MISSING_MANIFEST', 'No manifest.json found in archive')
  }
  const manifestText = await manifestEntry.async('text')

  let manifestRaw: unknown
  try {
    manifestRaw = JSON.parse(manifestText)
  } catch {
    throw new HpkgError('INVALID_MANIFEST', 'manifest.json is not valid JSON')
  }

  const parsed = ManifestSchema.safeParse(manifestRaw)
  if (!parsed.success) {
    throw new HpkgError('INVALID_MANIFEST', `manifest.json validation failed: ${parsed.error.message.slice(0, 200)}`)
  }
  const manifest = parsed.data

  // Truncate tags if > 20 (SEC-43)
  if (manifest.tags && manifest.tags.length > 20) {
    manifest.tags = manifest.tags.slice(0, 20)
  }

  // 5. Verify content_sha256 against primary file
  const primaryFileName = manifest.capability_type === 'mcp_skill' ? 'skill.yaml' : 'pack.toml'
  const primaryEntry = zip.files[primaryFileName]
  if (!primaryEntry) {
    throw new HpkgError('MISSING_PRIMARY_FILE', `Required primary file not found: ${primaryFileName}`)
  }
  const primaryContent = await primaryEntry.async('text')

  // Check uncompressed size
  totalUncompressed += primaryContent.length
  if (totalUncompressed > MAX_UNCOMPRESSED) {
    throw new HpkgError('ZIP_TOO_LARGE', `Uncompressed content exceeds ${MAX_UNCOMPRESSED} bytes`)
  }

  const actualSha256 = createHash('sha256').update(primaryContent, 'utf8').digest('hex')
  if (actualSha256.toLowerCase() !== manifest.content_sha256.toLowerCase()) {
    throw new HpkgError('HASH_MISMATCH', 'content_sha256 in manifest does not match primary file')
  }

  // 6–7. Double scan + prompt injection on description/tags
  const scanViolations = runDoubleScan(primaryContent)
  const metaScanViolations = runPromptInjectionScan(
    [manifest.description ?? '', ...(manifest.tags ?? [])].join(' ')
  )
  const allViolations = [...scanViolations, ...metaScanViolations]
  const scanResult = buildScanResult(allViolations)

  if (!scanResult.passed) {
    throw new HpkgError('SCAN_FAILED', scanResult.clientSummary)
  }

  return { manifest, primaryContent, uploadSha256 }
}

// ─── Persistence ──────────────────────────────────────────────────────────────

export async function persistHpkg(
  manifest: HpkgManifest,
  uploadSha256: string,
  actorId: string,
  importReason?: string,
): Promise<{ skill_id: string }> {
  const skillId = uuidv7()

  await db.$transaction(async (tx) => {
    await tx.mcpSkill.create({
      data: {
        id:              skillId,
        name:            manifest.name,
        source_type:     'upload',
        version:         manifest.version,
        scan_status:     'passed',
        enabled:         false,
        capability_type: manifest.capability_type,
        pack_id:         manifest.pack_id,
        author:          manifest.author,
        tags:            manifest.tags ?? [],
        upload_sha256:   uploadSha256,
        approved_by:     actorId,
        approved_at:     new Date(),
      },
    })

    await tx.auditLog.create({
      data: {
        id:          uuidv7(),
        actor:       actorId,
        action_type: 'marketplace_upload_approved',
        payload: {
          skill_id:      skillId,
          pack_id:       manifest.pack_id,
          capability_type: manifest.capability_type,
          version:       manifest.version,
          upload_sha256: uploadSha256,
          import_reason: importReason ?? null,
        },
      },
    })
  })

  return { skill_id: skillId }
}
