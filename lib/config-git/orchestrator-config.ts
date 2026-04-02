// lib/config-git/orchestrator-config.ts
// Read and write orchestrator.yaml for the admin UI.
//
// The file is written back with js-yaml.dump() — inline comments are not
// preserved, but the leading file header comment is re-injected.
// Every write is synced to config.git via syncInstanceConfig().

import { promises as fs } from 'fs'
import yaml               from 'js-yaml'
import { z }              from 'zod'

import { getOrchestratorYamlPath } from './paths'
import { syncInstanceConfig }      from '../bootstrap/sync-instance-config'

// ─── Zod schema for the fields exposed in the admin UI ───────────────────────

export const OrchestratorPatchSchema = z.object({
  organization: z.object({
    name:   z.string().min(1).max(120).optional(),
    preset: z.enum(['small_business', 'enterprise', 'developer']).optional(),
  }).optional(),

  execution_engine: z.object({
    provider:               z.enum(['custom', 'temporal', 'restate']).optional(),
    max_concurrent_nodes:   z.number().int().min(1).max(64).optional(),
  }).optional(),

  privacy: z.object({
    presidio: z.object({
      enabled: z.boolean(),
    }).optional(),
  }).optional(),

  litellm: z.object({
    enabled: z.boolean().optional(),
  }).optional(),

  proactivity: z.object({
    full_auto_enabled:      z.boolean().optional(),
    max_auto_runs_per_day:  z.number().int().min(1).max(1000).optional(),
    max_cost_usd_per_day:   z.number().min(0.01).max(10000).optional(),
  }).optional(),

  security: z.object({
    rate_limit_provider: z.enum(['memory', 'upstash']).optional(),
  }).optional(),

  updates: z.object({
    auto_install:     z.enum(['notify', 'auto', 'manual']).optional(),
    update_channel:   z.enum(['stable', 'edge']).optional(),
    auto_check:       z.boolean().optional(),
    auto_download:    z.boolean().optional(),
  }).optional(),

  marketplace: z.object({
    default_update_policy:  z.enum(['auto', 'notify', 'manual']).optional(),
    auto_check_updates:     z.boolean().optional(),
  }).optional(),
}).strict()

export type OrchestratorPatch = z.infer<typeof OrchestratorPatchSchema>

// ─── Coherence warnings (non-blocking) ───────────────────────────────────────

export interface CoherenceWarning {
  field:   string
  message: string
}

export function checkCoherence(
  patch:    OrchestratorPatch,
  current:  Record<string, unknown>,
): CoherenceWarning[] {
  const warnings: CoherenceWarning[] = []

  // Merge patch into current to evaluate the resulting config
  const merged = deepMerge(current, patch as Record<string, unknown>)

  const litellmEnabled = (merged as { litellm?: { enabled?: boolean } }).litellm?.enabled
  if (litellmEnabled && !process.env.LITELLM_GATEWAY_URL) {
    warnings.push({
      field:   'litellm.enabled',
      message: 'LITELLM_GATEWAY_URL env var is not set — LiteLLM gateway will not be reachable.',
    })
  }

  const presidioEnabled = (merged as { privacy?: { presidio?: { enabled?: boolean } } })
    .privacy?.presidio?.enabled
  if (presidioEnabled && !process.env.PRESIDIO_ENDPOINT) {
    warnings.push({
      field:   'privacy.presidio.enabled',
      message: 'PRESIDIO_ENDPOINT env var is not set — Presidio PII detection will not be reachable.',
    })
  }

  const rateLimitProvider = (merged as { security?: { rate_limit_provider?: string } })
    .security?.rate_limit_provider
  if (rateLimitProvider === 'upstash' && !process.env.UPSTASH_REDIS_REST_URL) {
    warnings.push({
      field:   'security.rate_limit_provider',
      message: 'UPSTASH_REDIS_REST_URL env var is not set — Upstash rate limiter will fail at runtime.',
    })
  }

  const executionProvider = (merged as { execution_engine?: { provider?: string } })
    .execution_engine?.provider
  if (executionProvider === 'temporal' && !process.env.TEMPORAL_ADDRESS) {
    warnings.push({
      field:   'execution_engine.provider',
      message: 'TEMPORAL_ADDRESS env var is not set — Temporal executor will not connect.',
    })
  }

  const fullAuto = (merged as { proactivity?: { full_auto_enabled?: boolean } })
    .proactivity?.full_auto_enabled
  if (fullAuto) {
    warnings.push({
      field:   'proactivity.full_auto_enabled',
      message: 'Full-auto mode allows the system to run pipelines without human confirmation.',
    })
  }

  return warnings
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function readOrchestratorYaml(): Promise<Record<string, unknown>> {
  try {
    const raw    = await fs.readFile(getOrchestratorYamlPath(), 'utf8')
    const parsed = yaml.load(raw)
    return (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>
  } catch {
    return {}
  }
}

// ─── Write ────────────────────────────────────────────────────────────────────

const FILE_HEADER = `# orchestrator.yaml — Harmoven instance configuration
# No secrets here — commit this file. Secrets go in .env (never committed).
# Auto-synced to config.git on every change via the admin UI or startup sync.
`

export async function patchOrchestratorYaml(
  patch:  OrchestratorPatch,
  _actor: string,
): Promise<{ warnings: CoherenceWarning[] }> {
  const current  = await readOrchestratorYaml()
  const warnings = checkCoherence(patch, current)

  const next = deepMerge(current, patch as Record<string, unknown>)

  const yamlStr = FILE_HEADER + '\n' + yaml.dump(next, {
    indent:       2,
    lineWidth:    100,
    quotingType:  '"',
    forceQuotes:  false,
    noRefs:       true,
  })

  await fs.writeFile(getOrchestratorYamlPath(), yamlStr, 'utf8')

  // Sync to config.git (non-blocking on error)
  await syncInstanceConfig().catch((err: unknown) => {
    console.warn('[orchestrator-config] config.git sync failed after patch:', err)
  })

  return { warnings }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deepMerge(
  base:    Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(overlay)) {
    if (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      typeof base[k] === 'object' &&
      base[k] !== null &&
      !Array.isArray(base[k])
    ) {
      result[k] = deepMerge(
        base[k] as Record<string, unknown>,
        v as Record<string, unknown>,
      )
    } else {
      result[k] = v
    }
  }
  return result
}
