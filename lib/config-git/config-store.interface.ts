// lib/config-git/config-store.interface.ts
// IConfigStore — contract for all config versioning backends.
// Amendment 83, Section 32.3 / 83.5.
//
// Default implementation: GitConfigStore (lib/config-git/config-store.ts)
// Uses a local bare git repository as a versioned key-value store.

// ─── Entry types ─────────────────────────────────────────────────────────────

/** Keys that can be stored per project or instance. */
export type ConfigKey =
  | 'project.json'
  | 'AGENTS.md'
  | 'orchestrator.yaml'
  | `roles/${string}.json`

export interface ConfigEntry {
  /** 'instance' for orchestrator.yaml; otherwise a project UUID. */
  project_id: string | 'instance'
  /** Relative filename within the project's config directory. */
  key:        ConfigKey
  /** Full serialized content — JSON string or raw YAML. */
  content:    string
}

// ─── Version / diff types ────────────────────────────────────────────────────

export interface ConfigVersion {
  /** Short git commit hash (7 chars). */
  hash:      string
  /** Auto-generated commit message. */
  message:   string
  /** user_id or 'system'. */
  author:    string
  timestamp: Date
  /** List of changed file paths (relative to config.git root). */
  changed:   string[]
}

export interface ConfigDiff {
  /** Content of the file at hash1. */
  before: string
  /** Content of the file at hash2. */
  after:  string
  /** Unified diff output. */
  patch:  string
}

// ─── Interface ───────────────────────────────────────────────────────────────

export interface IConfigStore {
  /** Read the current value for a key. Returns null if not found. */
  get(entry: Omit<ConfigEntry, 'content'>): Promise<string | null>

  /** Write a value and auto-commit with a generated message. Returns the new version. */
  set(entry: ConfigEntry, actor: string, note?: string): Promise<ConfigVersion>

  /**
   * List version history for a project or the instance config.
   * @param limit Max number of versions to return (default 50).
   */
  history(project_id: string | 'instance', limit?: number): Promise<ConfigVersion[]>

  /**
   * Get unified diff between two versions.
   * @param file Optional relative path to diff only one file.
   */
  diff(hash1: string, hash2: string, file?: string): Promise<ConfigDiff>

  /**
   * Restore config to a previous version — always a new forward commit.
   * Calls syncToDb() internally to keep the DB in sync.
   */
  restore(hash: string, actor: string): Promise<ConfigVersion>

  /** Export all current config entries as a JSON snapshot. */
  export(project_id: string | 'instance'): Promise<Record<string, string>>
}
