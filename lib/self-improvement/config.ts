// lib/self-improvement/config.ts
// Reads the self_improvement section from orchestrator.yaml.
// Pattern identical to lib/updates/version-check.ts:readUpdatesConfig.

import fs   from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import type { SelfImprovementConfig } from './types'
import { DEFAULT_SELF_IMPROVEMENT_CONFIG } from './types'

interface OrchestratorYaml {
  self_improvement?: Partial<SelfImprovementConfig>
  organization?: { deployment_mode?: string }
}

/** Returns the merged config (orchestrator.yaml overrides defaults). */
export function readSelfImprovementConfig(yamlPath?: string): SelfImprovementConfig {
  const filePath = yamlPath ?? path.resolve(process.cwd(), 'orchestrator.yaml')
  try {
    const raw    = fs.readFileSync(filePath, 'utf8')
    const parsed = (yaml.load(raw) as OrchestratorYaml) ?? {}
    return { ...DEFAULT_SELF_IMPROVEMENT_CONFIG, ...(parsed.self_improvement ?? {}) }
  } catch {
    return { ...DEFAULT_SELF_IMPROVEMENT_CONFIG }
  }
}

/** Returns true only when deployment_mode is 'docker'. */
export function isDockerDeployment(yamlPath?: string): boolean {
  const filePath = yamlPath ?? path.resolve(process.cwd(), 'orchestrator.yaml')
  try {
    const raw    = fs.readFileSync(filePath, 'utf8')
    const parsed = (yaml.load(raw) as OrchestratorYaml) ?? {}
    return parsed.organization?.deployment_mode === 'docker'
  } catch {
    return false
  }
}
