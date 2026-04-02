// lib/marketplace/update-checker.ts
// Per-skill SHA-256 comparison and pending_update write for the cron service (B.5.2).
//
// This module:
//   - Fetches the primary file(s) for a git-sourced skill
//   - Compares SHA-256 against installed_sha256
//   - If different: writes pending_update JSON (SEC-49: never writes content)
//   - If same: updates last_update_check_at only
//
// SEC-49: cron writes ONLY { changed_fields, new_sha256, detected_at } — never
//         prompt_template, allowed_tools, enabled, or any content field.

import { createHash } from 'node:crypto'
import { db } from '@/lib/db/client'
import { uuidv7 } from '@/lib/utils/uuidv7'
import { assertHostWhitelisted, fetchCappedText } from './resolve-github-url'
import { assertNotPrivateHost } from '@/lib/security/ssrf-protection'
import { resolveGitToken } from './git-provider-tokens'
import { runDoubleScan, buildScanResult } from './static-safety-scan'

export interface UpdateCheckResult {
  skill_id:   string
  up_to_date: boolean
  error?:     string
}

export async function checkSkillForUpdate(skillId: string): Promise<UpdateCheckResult> {
  const skill = await db.mcpSkill.findUnique({
    where:  { id: skillId },
    select: {
      id:              true,
      source_url:      true,
      source_ref:      true,
      installed_sha256: true,
    },
  })

  if (!skill?.source_url) {
    return { skill_id: skillId, up_to_date: true }
  }

  try {
    // Whitelist + SSRF check
    const parsedUrl = new URL(skill.source_url)
    await assertHostWhitelisted(parsedUrl.hostname)
    await assertNotPrivateHost(skill.source_url)

    // Build raw content URL
    const rawUrl = skill.source_url.includes('raw.githubusercontent.com')
      ? skill.source_url
      : buildRawUrl(skill.source_url, skill.source_ref)

    const content = await fetchCappedText(rawUrl)
    const newSha256 = createHash('sha256').update(content, 'utf8').digest('hex')

    if (newSha256 === skill.installed_sha256) {
      await db.mcpSkill.update({
        where: { id: skillId },
        data:  { last_update_check_at: new Date() },
      })
      return { skill_id: skillId, up_to_date: true }
    }

    // Changed — write pending_update (SEC-49: no content, just SHA-256 + field names)
    await db.mcpSkill.update({
      where: { id: skillId },
      data: {
        last_update_check_at: new Date(),
        pending_update: {
          changed_fields: ['prompt_template'],
          new_sha256: { [rawUrl]: newSha256 },
          detected_at: new Date().toISOString(),
        },
      },
    })

    return { skill_id: skillId, up_to_date: false }
  } catch (e) {
    // Log error but don't crash the whole cron run
    await db.mcpSkill.update({
      where: { id: skillId },
      data:  { last_update_check_at: new Date() },
    }).catch(() => {})
    return { skill_id: skillId, up_to_date: true, error: String(e).slice(0, 200) }
  }
}

function buildRawUrl(sourceUrl: string, sourceRef: string | null | undefined): string {
  // Convert github.com URL to raw.githubusercontent.com
  const match = sourceUrl.match(/github\.com\/([^/]+)\/([^/]+)(?:\/blob\/([^/]+))?\/(.+)/)
  if (match) {
    const [, owner, repo, , filePath] = match as [string, string, string, string, string]
    const ref = sourceRef || 'HEAD'
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`
  }
  // Already a raw URL
  if (sourceUrl.includes('raw.githubusercontent.com')) return sourceUrl
  throw new Error(`Cannot construct raw URL from: ${sourceUrl}`)
}

// ─── Batch cron run ───────────────────────────────────────────────────────────

export async function runUpdateChecks(maxPerRun: number): Promise<{
  checked: number
  updated: number
  errors:  number
}> {
  // Cleanup expired GitHubImportPreview records first (V8 — runs at cron start)
  await db.gitHubImportPreview.deleteMany({
    where: { expires_at: { lt: new Date() } },
  }).catch(() => {})

  // Select oldest-checked git-sourced skills
  const skills = await db.mcpSkill.findMany({
    where:   { source_type: 'git' },
    orderBy: { last_update_check_at: 'asc' },
    take:    maxPerRun,
    select:  { id: true },
  })

  let checked = 0
  let updated = 0
  let errors  = 0

  for (const skill of skills) {
    const result = await checkSkillForUpdate(skill.id)
    checked++
    if (!result.up_to_date) updated++
    if (result.error) errors++
  }

  return { checked, updated, errors }
}
