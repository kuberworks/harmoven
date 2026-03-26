// lib/config-git/paths.ts
// Filesystem paths for config.git — Amendment 83, Section 32.2.
//
// DEPLOYMENT_MODE controls location:
//   docker (default) → CONFIG_GIT_PATH env var or '/data/config.git'
//   electron         → app.getPath('userData')/harmoven/config.git
//
// SECURITY: All paths returned here are passed to assertSafePath()
// before being handed to execFileAsync(). The root itself is
// validated at startup by initConfigRepo().

import path from 'path'
import os   from 'os'

/**
 * Absolute path to the config.git repository root.
 * The directory will be initialized on first startup by initConfigRepo().
 */
export function getConfigGitRoot(): string {
  if (process.env.DEPLOYMENT_MODE === 'electron') {
    // In tests, app is not available — fall back to os.tmpdir()
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { app } = require('electron') as typeof import('electron')
      return path.join(app.getPath('userData'), 'harmoven', 'config.git')
    } catch {
      return path.join(os.tmpdir(), 'harmoven', 'config.git')
    }
  }
  // Docker / dev
  return process.env.CONFIG_GIT_PATH ?? '/data/config.git'
}

/**
 * Absolute path to the orchestrator.yaml being managed by this process.
 * Defaults to <project_root>/orchestrator.yaml.
 */
export function getOrchestratorYamlPath(): string {
  return process.env.ORCHESTRATOR_YAML_PATH
    ?? path.join(process.cwd(), 'orchestrator.yaml')
}
