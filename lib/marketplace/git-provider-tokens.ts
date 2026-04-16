// lib/marketplace/git-provider-tokens.ts
// Git provider token resolution (A.5.2).
//
// Resolution order for outgoing Git fetches:
//   1. DB token matching hostname via micromatch (most specific pattern wins)
//   2. Env var fallback: GITHUB_TOKEN, GITLAB_TOKEN, BITBUCKET_TOKEN
//   3. Anonymous (no Authorization header)
//
// Specificity ordering (L12):
//   1. Exact hostname match (no wildcards)
//   2. Glob with single * 
//   3. Glob with **
//   4. Ties: created_at ASC (oldest wins)
//
// SEC-46: token_enc never returned to clients; resolved header is server-side only.
// SEC-47: token selection is entirely server-side; client has no influence.

import micromatch from 'micromatch'
import { db } from '@/lib/db/client'
import { decryptValue } from '@/lib/utils/credential-crypto-ext'

// ─── Specificity scoring (L12) ────────────────────────────────────────────────

function patternSpecificity(pattern: string): number {
  if (!pattern.includes('*')) return 3   // exact match — highest priority
  if (pattern.includes('**')) return 1   // multi-level glob — lowest priority
  return 2                               // single * glob — medium priority
}

// ─── Token resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the Authorization header for a given hostname.
 * Returns the header value string (e.g. "Bearer ghp_xxx") or null if anonymous.
 *
 * Disabled tokens are excluded before sorting.
 */
export async function resolveGitToken(hostname: string): Promise<string | null> {
  // 1. DB tokens
  const allTokens = await db.gitProviderToken.findMany({
    where:   { enabled: true },
    select:  { host_pattern: true, token_enc: true, created_at: true },
    orderBy: { created_at: 'asc' },
  })

  // Filter to patterns matching the hostname
  const matching = allTokens.filter((t) =>
    micromatch.isMatch(hostname, t.host_pattern),
  )

  if (matching.length > 0) {
    // Sort by specificity descending, then created_at ascending (ties)
    matching.sort((a, b) => {
      const sc = patternSpecificity(b.host_pattern) - patternSpecificity(a.host_pattern)
      if (sc !== 0) return sc
      return a.created_at.getTime() - b.created_at.getTime()
    })

    const best = matching[0]!
    try {
      const raw = decryptValue(best.token_enc)
      // Detect Bitbucket user:apppass format (Basic auth)
      if (raw.includes(':')) {
        return `Basic ${Buffer.from(raw).toString('base64')}`
      }
      return `Bearer ${raw}`
    } catch {
      // Decryption failure — fall through to env var
    }
  }

  // 2. Env var fallbacks
  if (hostname === 'github.com' || hostname === 'api.github.com' || hostname === 'raw.githubusercontent.com') {
    const t = process.env.GITHUB_TOKEN
    if (t) return `Bearer ${t}`
  }
  if (hostname.includes('gitlab')) {
    const t = process.env.GITLAB_TOKEN
    if (t) return `Bearer ${t}`
  }
  if (hostname === 'bitbucket.org') {
    const t = process.env.BITBUCKET_TOKEN
    if (t) return `Bearer ${t}`
  }

  // 3. Anonymous
  return null
}
