// lib/bootstrap/sync-instance-config.ts
// syncInstanceConfig — version orchestrator.yaml in config.git on startup.
// Amendment 83 (Section 83.9).
//
// Called once at application startup, after initConfigRepo().
// If the current orchestrator.yaml differs from what's in config.git,
// a new commit is created automatically.
//
// This ensures config.git always reflects the currently running configuration,
// making the history useful: every change to orchestrator.yaml is captured
// even when it was edited directly on disk (e.g. via docker exec or scp).

import { promises as fs } from 'fs'
import { existsSync }      from 'fs'

import { configStore }          from '@/lib/config-git/config-store'
import { getOrchestratorYamlPath } from '@/lib/config-git/paths'

/**
 * Check whether the current orchestrator.yaml differs from the last
 * committed version in config.git, and commit if so.
 *
 * Non-throwing — config-git sync failure never prevents startup.
 */
export async function syncInstanceConfig(): Promise<void> {
  try {
    const yamlPath = getOrchestratorYamlPath()

    if (!existsSync(yamlPath)) {
      // No orchestrator.yaml — nothing to sync (e.g. test environment)
      return
    }

    const current = await fs.readFile(yamlPath, 'utf8')
    const stored  = await configStore.get({
      project_id: 'instance',
      key:        'orchestrator.yaml',
    })

    if (current === stored) {
      // Already up to date
      return
    }

    await configStore.set(
      { project_id: 'instance', key: 'orchestrator.yaml', content: current },
      'system',
      'auto-synced on startup',
    )
  } catch (err) {
    // Log but never throw — startup must succeed even if config.git is broken
    console.warn('[syncInstanceConfig] Failed to sync orchestrator.yaml to config.git:', err)
  }
}
