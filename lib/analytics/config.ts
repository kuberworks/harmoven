// lib/analytics/config.ts
// Read analytics configuration from orchestrator.yaml (Amendment 85.8).
// Falls back to safe defaults if the file is absent or the analytics section missing.

import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'

interface OrchestratorAnalytics {
  enabled?: boolean
  hourly_rate_usd?: number
  anonymize_exports?: boolean
  retention_days?: number
}

interface OrchestratorYaml {
  analytics?: OrchestratorAnalytics
}

export interface AnalyticsConfig {
  enabled: boolean
  hourly_rate_usd: number
  anonymize_exports: boolean
  retention_days: number
}

const DEFAULTS: AnalyticsConfig = {
  enabled: true,
  hourly_rate_usd: 75.0,
  anonymize_exports: false,
  retention_days: 365,
}

let _cached: AnalyticsConfig | null = null

export function getAnalyticsConfig(): AnalyticsConfig {
  if (_cached) return _cached

  try {
    const yamlPath = path.resolve(process.cwd(), 'orchestrator.yaml')
    const raw = fs.readFileSync(yamlPath, 'utf8')
    const doc = yaml.load(raw) as OrchestratorYaml
    const a = doc?.analytics ?? {}
    _cached = {
      enabled:           a.enabled           ?? DEFAULTS.enabled,
      hourly_rate_usd:   a.hourly_rate_usd   ?? DEFAULTS.hourly_rate_usd,
      anonymize_exports: a.anonymize_exports  ?? DEFAULTS.anonymize_exports,
      retention_days:    a.retention_days     ?? DEFAULTS.retention_days,
    }
  } catch {
    _cached = { ...DEFAULTS }
  }

  return _cached
}

/** Reset the cache — intended for tests only. */
export function _resetAnalyticsConfigCache(): void {
  _cached = null
}
