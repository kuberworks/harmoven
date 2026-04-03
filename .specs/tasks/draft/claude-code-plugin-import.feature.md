---
title: "Coding Agent Plugin Import — Register Claude Code or Codex plugin git repos as callable McpSkills in Harmoven"
status: draft
created: 2026-04-03
depends_on: []
agents_completed: []
agents_pending: [researcher, code-explorer, implementer]
---

## Overview

Allow an admin to paste a `.git` URL of an existing **Claude Code plugin** or
**OpenAI Codex plugin** and have Harmoven import it, build it (sandboxed), and
make its tools and skills available to pipeline agents exactly like any other
`McpSkill`.

**This spec is distinct from `claude-code-plugin.feature.md`**, which is about
Harmoven itself exposing an MCP server *for* Claude Code.  
Here, the direction is reversed: a coding-agent plugin becomes a **tool
provider** *inside* Harmoven's orchestration engine.

---

## Background — Plugin formats

### Claude Code plugin

A Claude Code plugin is a git repository that ships one or more of:

| Component | Detection signal | Harmoven target |
|-----------|-----------------|-----------------|
| Runnable MCP server (Node/Python) | `package.json` + MCP entrypoint in `bin`/`scripts.start`; or `.claude/settings.json` `mcpServers` block | `McpSkill` (`capability_type='claude_plugin'`) |
| Slash commands | `commands/*.md` or `.claude/commands/*.md` | `PipelineSkill` record |
| Skills (`.claude/skills/`) | `.claude/skills/<name>/SKILL.md` or `.claude-plugin/` dir with skill files | `PipelineSkill` record |
| CLAUDE.md domain pack | `CLAUDE.md` | `InstalledPack` (`pack_type='domain_pack'`, already handled) |
| Hooks (`.claude/hooks/`) | Any `.claude/hooks/` file | **Always rejected** |

> **Real-world note (ui-ux-pro-max):** Many popular Claude Code plugins
> (e.g. `nextlevelbuilder/ui-ux-pro-max-skill`) store their skills under
> `.claude/skills/` rather than `commands/`. The current `buildClaudePluginReport`
> only scans `commands/*.md` and `.claude/commands/*.md` — this path must be
> extended to also scan `.claude/skills/**/*.md` and `.claude-plugin/**/*.md`.

### OpenAI Codex plugin

A Codex plugin is a git repository with `.codex-plugin/plugin.json` as the
required entry point (ref: [developers.openai.com/codex/plugins/build](https://developers.openai.com/codex/plugins/build)).

| Component | Location | Harmoven target |
|-----------|----------|-----------------|
| Plugin manifest | `.codex-plugin/plugin.json` | Detection + metadata |
| MCP servers | `.mcp.json` (referenced by `mcpServers` field in manifest) | `McpSkill` (`capability_type='codex_plugin'`) |
| Skills | `skills/<name>/SKILL.md` (referenced by `skills` field in manifest) | `PipelineSkill` record |
| App integrations | `.app.json` | **Out of scope v1** |
| Hooks (`.codex-plugin/hooks/`) | Any hooks file | **Always rejected** |

`.mcp.json` format (STDIO example):
```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {}
    }
  }
}
```

`SKILL.md` format:
```markdown
---
name: review-pr
description: Review a pull request and suggest improvements.
---

Review the pull request diff. List issues by severity. Suggest fixes.
```

### The priority gaps today

1. **No install step** — `detectRepoType` produces a `ClaudePluginReport` with
   `mcp_servers_detected` and `converted` items, but nothing is ever persisted
   or built.
2. **`.claude/skills/` not scanned** — `buildClaudePluginReport` only processes
   `commands/*.md` and `.claude/commands/*.md`. Skills stored under
   `.claude/skills/<name>/SKILL.md` (common in popular plugins like
   `ui-ux-pro-max-skill`) are silently ignored.
3. **No Codex plugin detection** — `codex_plugin` type does not exist yet.
4. **Prompt-only plugins not handled** — plugins with zero MCP servers (pure
   skill/prompt packs) currently yield an empty install with no feedback.

---

## Scope

### In scope

- **Detection (Codex)** — add `codex_plugin` type + `buildCodexPluginReport()` to
  `lib/marketplace/detect-repo-type.ts` (new Priority 0, before all others,
  since `.codex-plugin/plugin.json` is unambiguous)
- **Detection fix (Claude Code)** — extend `buildClaudePluginReport` to also
  scan `.claude/skills/**/*.md` and `.claude-plugin/**/*.md` (skill files),
  in addition to the existing `commands/*.md` + `.claude/commands/*.md` paths
- **Admin UI** — git URL input in the existing marketplace import flow already
  calls `detectRepoType`; extend preview dialog to handle both
  `claude_plugin` and `codex_plugin` detection results
- **Build sandbox (Node.js)** — clone + `npm install --omit=dev --ignore-scripts`
  + optional `npm run build` inside a `child_process` (120 s, strict env)
- **Build sandbox (Python)** — detect `pyproject.toml`/`setup.py`/`requirements.txt`,
  run `uv sync --no-dev` (preferred) or `pip install -r requirements.txt --no-deps`
  (fallback); `uv` and `python3` already in `ALLOWED_MCP_COMMANDS`
- **Runtime command** resolved per language: `node`/`npx` for Node.js,
  `python3`/`uv run` for Python — validated via `ALLOWED_MCP_COMMANDS` +
  `validateMcpConfig()` at install time
- **McpSkill records** created for each MCP server entry
  (`source_type='git'`, `capability_type='claude_plugin'` or `'codex_plugin'`,
  `scan_status='pending'`), pending admin approval
- **`PipelineSkill` records** created for each converted slash command,
  `.claude/skills/` skill (Claude Code), or `SKILL.md` skill (Codex) —
  new lightweight model (renamed from `PipelineSlashCommand`)
- **Prompt-only plugin warning** — when `mcp_servers_detected = []` after
  install, the UI shows an explicit notice: *"This plugin contains no MCP
  server. Its skills are imported as PipelineSkill prompt-templates and are
  not callable as tools from a pipeline agent node."* Install still proceeds
  (skills are useful as prompt context); no error is raised
- Admin approve/reject flow reuses existing `McpSkill` UI — no new UI needed
- Once approved + enabled, MCP tools callable via existing `mcpSkillClient`
- `openapi/v1.yaml` updated for any new API endpoints

### Out of scope

- Rust/Go plugin build — v1 supports Node.js and Python only
- Codex `.app.json` (app/connector mappings) — v1 ignores app integrations
- Auto-update polling (reuse existing `update-checker.ts` later)
- Skill/slash command execution inside pipeline nodes (separate spec)
- Docker-based full isolation (v1 uses `child_process` + env allowlist,
  same pattern as existing `McpSkillClient`)

---

## User journey

```
Admin → Marketplace → "Import from URL"
  → pastes https://github.com/acme/my-plugin.git

  ── Claude Code path ──────────────────────────────────────────────────────
  → POST /api/admin/marketplace/analyze-command
      → detectRepoType() → detected_type = 'claude_plugin'
      → buildClaudePluginReport() (extended)
          scans commands/*.md + .claude/commands/*.md  (existing)
          scans .claude/skills/**/*.md                 (NEW)
          scans .claude-plugin/**/*.md                 (NEW)
  → UI shows preview:
      · MCP servers detected (from .claude/settings.json + package.json bin)
      · Skills / slash commands found (converted[])
      · Skipped items with reason
      · ⚠ Warning banner if mcp_servers_detected = [] (prompt-only plugin)

  ── Codex path ────────────────────────────────────────────────────────────
  → POST /api/admin/marketplace/analyze-command
      → detectRepoType() → detected_type = 'codex_plugin'  ← NEW
      → buildCodexPluginReport()                            ← NEW
          reads .codex-plugin/plugin.json
          reads .mcp.json → mcp_servers_detected
          reads skills/*/SKILL.md → converted_skills[]
  → UI shows preview:
      · Plugin name + description (from plugin.json manifest)
      · MCP servers detected
      · Skills found (SKILL.md files)
      · App integrations skipped (out of scope v1)

  ── Unified install step ──────────────────────────────────────────────────
  → Admin clicks "Install"
  → POST /api/admin/marketplace/coding-agent-plugin-install
      → SSRF guard on git URL
      → re-run detectRepoType server-side
      → static-safety-scan
      → shallow clone (--depth=1, max 50 MB, max 120 s)
      → build sandbox (Node.js or Python, per detected language)
        (skipped if mcp_servers_detected = [] — no executable to build)
      → for each mcp_servers_detected:
            create McpSkill { source_type='git',
                              capability_type='claude_plugin'|'codex_plugin',
                              scan_status='pending', enabled=false }
      → for each converted skill / slash command / SKILL.md:
            create PipelineSkill { status='pending' }
      → if mcp_servers_detected = []:
            return { ...result, warning: 'PROMPT_ONLY_PLUGIN' }
  → Admin reviews each McpSkill → approve → enabled=true
  → Pipeline agent nodes can now call tools from this plugin
  (if prompt-only: skills available as prompt context only)
```

---

## Data model changes

### `McpSkill` — no schema change needed

Existing fields cover both plugin types:
- `source_type = 'git'`
- `capability_type = 'claude_plugin'` | `'codex_plugin'`
- `config: Json` → `{ command: "node", args: ["dist/index.js"], env: {} }`
- `source_url` → original git URL
- `source_ref` → resolved commit SHA at import time

### `PipelineSkill` — NEW model

Replaces the previously named `PipelineSlashCommand` to cover both Claude Code
slash commands and Codex `SKILL.md` skills under one unified model.

```prisma
model PipelineSkill {
  id            String   @id @default(uuid())
  skill_name    String   @unique  // slugified, e.g. "review_pr"
  origin_format String            // "claude_slash_command" | "codex_skill"
  description   String?
  prompt_body   String            // the .md content (slash command or SKILL.md body)
  allowed_tools String[]          // mcp__ references — informational only
  source_url    String?           // origin git repo
  source_path   String            // e.g. "commands/review_pr.md" or "skills/review-pr/SKILL.md"
  status        String   @default("pending") // pending | approved | rejected
  approved_by   String?
  approved_at   DateTime?
  created_at    DateTime @default(now())
  created_by    String

  @@index([status])
  @@index([origin_format])
}
```

### `CapabilityType` in `detect-repo-type.ts` — extend

Add `'codex_plugin'` to the existing `CapabilityType` union:

```ts
export type CapabilityType =
  | 'domain_pack'
  | 'mcp_skill'
  | 'harmoven_agent'
  | 'js_ts_plugin'
  | 'slash_command'
  | 'harmoven_package'
  | 'claude_plugin'
  | 'codex_plugin'   // NEW
  | 'unrecognized'
```

### `CodexPluginReport` — NEW type in `detect-repo-type.ts`

```ts
export interface CodexPluginReport {
  detected_type:   'codex_plugin'
  plugin_metadata: {
    name?:        string
    version?:     string
    description?: string
    author?:      string
    license?:     string
    keywords?:    string[]
  }
  mcp_servers_detected: Array<{
    name:     string
    command:  string
    args?:    string[]
    env?:     Record<string, string>
  }>
  skills_detected: Array<{
    source:      string  // relative path, e.g. "skills/review-pr/SKILL.md"
    skill_name:  string  // from frontmatter `name` field
    description: string  // from frontmatter `description` field
    prompt_body: string  // body after frontmatter
    status:      'ready' | 'unsafe'
  }>
  apps_detected:   number  // count of .app.json entries (informational — skipped)
  skipped:         Array<{ source: string; reason: string }>
}
```

---

## New API routes

### `POST /api/admin/marketplace/coding-agent-plugin-install`

Auth: `instance_admin` only. Handles both Claude Code and Codex plugins via
unified endpoint (type detected server-side).

Request body:
```json
{
  "git_url": "https://github.com/acme/my-plugin.git",
  "ref": "main"
}
```

Steps (in order):
1. Zod validate `git_url` (HTTPS only — no `git://` or `ssh://`)
2. `assertNotPrivateHost(git_url)` — SSRF guard
3. Re-run `detectRepoType` server-side (never trust client-supplied detection)
4. If `detected_type` not in `['claude_plugin', 'codex_plugin']` → 400 `WRONG_TYPE`
5. If `scan_passed === false` → 400 `SCAN_FAILED`
6. Shallow clone to `mkdtemp` dir (`--depth=1`, max 50 MB, max 120 s)
7. Language detection + build sandbox (§Scope above)
8. Resolve entrypoints per `mcp_servers_detected`, validate via
   `ALLOWED_MCP_COMMANDS` + `validateMcpConfig()`
9. DB transaction: create `McpSkill` records + `PipelineSkill` records
10. Emit audit log event `coding_agent_plugin_imported` with `plugin_type`
11. Return `{ pluginType, mcpSkills: [...ids], skills: [...ids] }`

Error codes:
- `400 WRONG_TYPE` — neither claude_plugin nor codex_plugin
- `400 SCAN_FAILED` — content scan violation
- `400 BUILD_FAILED` — install/build timeout or non-zero exit
- `400 NO_ENTRYPOINT` — no runnable MCP entrypoint found
- `409 ALREADY_INSTALLED` — McpSkill with same `source_url` already exists

---

## Security considerations

| Risk | Mitigation |
|------|------------|
| Arbitrary code execution via `postinstall` scripts | `npm install --omit=dev --ignore-scripts` — postinstall scripts never run |
| Malicious build script | `npm run build` runs in child_process with env restricted to `safeBaseEnv()` + `PATH` (no secrets, no tokens) |
| SSRF via git URL | `assertNotPrivateHost()` before any network call |
| Repo size bomb | Clone aborted after 50 MB or 500 files (git shallow clone `--depth=1`) |
| Prompt injection in plugin content | Already handled by `runDoubleScan()` in `buildClaudePluginReport` |
| Symlink attack in repo | `realpath()` check to ensure resolved paths stay inside clone dir |
| Admin privilege escalation | Route requires `instance_admin` — no project-scoped role suffices |
| Command injection in `mcp_servers_detected.command` | Validated against `ALLOWED_MCP_COMMANDS` allowlist (`node`, `npx`) before `McpSkill` creation — same as existing install flow |
| Sandbox escape via environment | `mcpSkillEnv()` used at runtime (same as existing `McpSkillClient`) — never `process.env` spread |

---

## Implementation plan

### Phase 1 — Detection + sandbox + install endpoint

1. **`lib/marketplace/detect-repo-type.ts`** — add Codex detection:
   - New `CapabilityType` value `'codex_plugin'`
   - New `CodexPluginReport` interface
   - New `buildCodexPluginReport()` function: reads `.codex-plugin/plugin.json`,
     parses `.mcp.json` for `mcpServers`, scans `skills/*/SKILL.md` files
     (same `runDoubleScan` + `parseFrontmatter` helpers already present)
   - Insert as Priority 0 in `detectRepoType` (checked before all others,
     since `.codex-plugin/` is unambiguous)

2. **`lib/marketplace/sandbox/clone.ts`** — shallow git clone helper
   (`git clone --depth=1 --single-branch`, 50 MB cap, 120 s timeout)

3. **`lib/marketplace/sandbox/build.ts`** — language-aware build runner:
   - **Node.js** (`package.json`): `npm install --omit=dev --ignore-scripts`
     then optional `npm run build`
   - **Python** (`pyproject.toml` / `setup.py` / `requirements.txt`):
     `uv sync --no-dev` or fallback `pip install -r requirements.txt --no-deps`
   - Returns `{ command, args }` validated against `ALLOWED_MCP_COMMANDS` +
     `validateMcpConfig()`

4. **`lib/marketplace/sandbox/resolve-entrypoint.ts`** — given
   `mcp_servers_detected` entry + cloned dir + language, resolve final
   `command`/`args`; for Codex: also parse `.mcp.json` directly

5. **`app/api/admin/marketplace/coding-agent-plugin-install/route.ts`**
   — unified POST handler (auth + Zod + full install pipeline)

6. **DB migration** — add `PipelineSkill` model

### Phase 2 — Admin UI

1. **`app/(app)/admin/marketplace/`** — extend preview dialog:
   - `claude_plugin`: MCP servers + slash commands + skipped items
   - `codex_plugin`: plugin name/version/description (from manifest) + MCP
     servers + skills + app integrations skipped
   - Unified "Install" button → calls `coding-agent-plugin-install`
2. **i18n** — `locales/en.json` + `locales/fr.json`:
   - `marketplace.claudePlugin.*` keys
   - `marketplace.codexPlugin.*` keys

### Phase 3 — openapi + tests

1. **`openapi/v1.yaml`** — document
   `POST /api/admin/marketplace/coding-agent-plugin-install`
   and `PipelineSkill` schema
2. **Unit tests**:
   - `tests/marketplace/sandbox/clone.test.ts`
   - `tests/marketplace/sandbox/build.test.ts` (Node.js + Python paths)
   - `tests/marketplace/detect-repo-type-codex.test.ts`
   - `tests/api/admin/marketplace/coding-agent-plugin-install.test.ts`
3. **Integration tests**: fixture repos for both plugin types

---

## Acceptance criteria

### Claude Code plugin
- [ ] Pasting a Claude Code plugin git URL shows preview with MCP servers, slash commands, and `.claude/skills/` skills
- [ ] `.claude/skills/**/*.md` files scanned and imported as `PipelineSkill` records
- [ ] `.claude-plugin/**/*.md` skill files also scanned
- [ ] Slash commands imported as `PipelineSkill` records (`origin_format='claude_slash_command'`)
- [ ] Plugin with `mcp_servers_detected = []` (e.g. ui-ux-pro-max) succeeds — shows `PROMPT_ONLY_PLUGIN` warning banner, no error
- [ ] Prompt-only plugin: build sandbox step skipped, only `PipelineSkill` records created

### Codex plugin
- [ ] Pasting a Codex plugin git URL detects `codex_plugin` type and shows plugin name,
      MCP servers, skills, and "app integrations skipped" notice
- [ ] `.mcp.json` MCP server entries imported as `McpSkill` records
      (`capability_type='codex_plugin'`)
- [ ] `skills/*/SKILL.md` entries imported as `PipelineSkill` records
      (`origin_format='codex_skill'`)
- [ ] `.app.json` entries silently skipped with no error

### Common
- [ ] Clicking "Install" creates `McpSkill` records with `scan_status='pending'` + `enabled=false`
- [ ] `npm install --ignore-scripts` — no postinstall scripts run
- [ ] Python: `uv sync --no-dev` used when `uv` is available
- [ ] Clone aborted if repo exceeds 50 MB or 120 s wall-clock
- [ ] `mcp_servers_detected.command` not in `ALLOWED_MCP_COMMANDS` → 400 error
- [ ] After admin approval + enable, `mcpSkillClient.callTool()` works
- [ ] SSRF guard blocks private IP git URLs
- [ ] Endpoint returns 401 for non-`instance_admin` callers
- [ ] `openapi/v1.yaml` updated
- [ ] `npx tsc --noEmit` passes with zero errors

---

## Test plan

| Test | Type | File |
|------|------|------|
| SSRF guard rejects `git://127.0.0.1/repo` | Unit | `tests/marketplace/sandbox/clone.test.ts` |
| Repo > 50 MB aborts with `REPO_TOO_LARGE` | Unit | `tests/marketplace/sandbox/clone.test.ts` |
| `--ignore-scripts` — postinstall skipped | Unit | `tests/marketplace/sandbox/build.test.ts` |
| Build timeout → `BUILD_FAILED` | Unit | `tests/marketplace/sandbox/build.test.ts` |
| Python: `uv sync` installs deps + entrypoint resolved | Unit | `tests/marketplace/sandbox/build.test.ts` |
| Python: fallback to `pip install` when `uv` absent | Unit | `tests/marketplace/sandbox/build.test.ts` |
| Codex: `.codex-plugin/plugin.json` → `codex_plugin` detected | Unit | `tests/marketplace/detect-repo-type-codex.test.ts` |
| Codex: `.mcp.json` parsed → `mcp_servers_detected` populated | Unit | `tests/marketplace/detect-repo-type-codex.test.ts` |
| Codex: `skills/*/SKILL.md` parsed → `skills_detected` populated | Unit | `tests/marketplace/detect-repo-type-codex.test.ts` |
| Codex: `.app.json` present → `apps_detected` count, no error | Unit | `tests/marketplace/detect-repo-type-codex.test.ts` |
| Claude Code: `.claude/skills/*/SKILL.md` → converted in report | Unit | `tests/marketplace/detect-repo-type.test.ts` |
| Claude Code: `.claude-plugin/**/*.md` → converted in report | Unit | `tests/marketplace/detect-repo-type.test.ts` |
| Prompt-only plugin (no mcp_servers) → install succeeds + `PROMPT_ONLY_PLUGIN` warning | Unit | `tests/api/admin/marketplace/coding-agent-plugin-install.test.ts` |
| Prompt-only plugin: build sandbox NOT called | Unit | `tests/api/admin/marketplace/coding-agent-plugin-install.test.ts` |
| ui-ux-pro-max fixture: `.claude/skills/` imported as PipelineSkill | Integration | `tests/marketplace/coding-agent-plugin-install.test.ts` |
| Non-allowlisted command → 400 | Unit | `tests/api/admin/marketplace/coding-agent-plugin-install.test.ts` |
| Claude Code fixture plugin → McpSkill + PipelineSkill created | Integration | `tests/marketplace/coding-agent-plugin-install.test.ts` |
| Codex fixture plugin → McpSkill + PipelineSkill created | Integration | `tests/marketplace/coding-agent-plugin-install.test.ts` |
| `mcpSkillClient.callTool` works post-approval | Integration | `tests/mcp/client.test.ts` |

---

## Open questions

1. **Persistent clone storage** — Should the cloned repo be kept on disk
   (`data/plugins/<skill_id>/`) for restarts, or should Harmoven re-clone on
   startup? Re-clone is simpler but adds boot latency; keeping it requires a
   cleanup policy for uninstalled plugins.

2. ~~**Python/Go plugins**~~ — `python3`, `uv`, `uvx` already in
   `ALLOWED_MCP_COMMANDS`. Python is **in scope for v1**.

3. **Entrypoint source priority** — Codex: `.mcp.json` authoritative.
   Claude Code: `.claude/settings.json` preferred, fall back to `package.json`
   `bin`. If neither present → `mcp_servers_detected = []` → prompt-only path.

5. **`.claude/skills/` depth limit** — the scan covers
   `.claude/skills/<name>/SKILL.md` (one level deep) and
   `.claude-plugin/**/*.md` (up to 2 levels). Deeper nesting is skipped with
   reason `NESTING_TOO_DEEP` to prevent scanning runaway directory trees.

4. **`PipelineSkill` execution** — Once records exist, how are they triggered
   from a pipeline node? Deferred to a separate spec, but model fields should
   accommodate both invocation styles (explicit `$skill-name` and
   implicit via description matching).
