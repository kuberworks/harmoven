// lib/auth/signup-policy.ts
// Read the allow_public_signup flag from orchestrator.yaml.
//
// Priority (highest wins):
//   1. HARMOVEN_ALLOW_PUBLIC_SIGNUP=true env var  (operator override for SaaS)
//   2. security.allow_public_signup in orchestrator.yaml (default: false)
//
// Server-only — never import from client components.

import fs   from 'fs'
import yaml from 'js-yaml'
import { getOrchestratorYamlPath } from '@/lib/config-git/paths'

interface OrchestratorSecurity {
  allow_public_signup?: boolean
}

interface OrchestratorYaml {
  security?: OrchestratorSecurity
}

/**
 * Returns true if new users may self-register at /register.
 * False means registration is closed — only admins can create accounts.
 */
export function isPublicSignupAllowed(): boolean {
  // Env var override (operator escape hatch — useful for SaaS deployments)
  if (process.env.HARMOVEN_ALLOW_PUBLIC_SIGNUP === 'true') return true
  if (process.env.HARMOVEN_ALLOW_PUBLIC_SIGNUP === 'false') return false

  try {
    const raw    = fs.readFileSync(getOrchestratorYamlPath(), 'utf8')
    const parsed = yaml.load(raw) as OrchestratorYaml | null
    return parsed?.security?.allow_public_signup ?? false
  } catch {
    // File missing or unparseable — default closed (safe)
    return false
  }
}
