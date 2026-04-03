---
title: "Claude Code Plugin — Harmoven MCP server for Claude Code integration"
status: draft
created: 2026-04-03
depends_on: ["marketplace-v2.feature.md"]
agents_completed: []
agents_pending: [researcher, code-explorer, implementer]
---

## Overview

Expose Harmoven as a first-class **MCP server** consumable directly by
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) (Anthropic's
coding CLI/IDE agent).  
Once configured, Claude Code users gain native access to Harmoven tools inside
their coding sessions: trigger pipelines, inspect run status, approve human
gates, and query agent outputs — all without leaving the editor.

Integration surface: **HTTP+SSE MCP transport** (streamable HTTP, per MCP spec
§6.1) served by Harmoven at `/api/mcp`.  
Auth: **Project API key** passed as `Authorization: Bearer <key>` header.  
Packaging: the connection settings are also publishable as a **Harmoven
marketplace skill pack** so teams can distribute the config internally.

---

## Background — How Claude Code consumes MCP servers

Claude Code resolves MCP servers from four locations (highest priority first):

| Scope | File |
|-------|------|
| Enterprise policy | `~/.claude/managed_settings.json` (admin-deployed) |
| User-global | `~/.claude/settings.json` |
| Project-local | `.claude/settings.json` (committed to repo) |
| Project-local (gitignored) | `.claude/settings.local.json` |

A server entry looks like:

```json
{
  "mcpServers": {
    "harmoven": {
      "type": "http",
      "url": "https://harmoven.example.com/api/mcp",
      "headers": {
        "Authorization": "Bearer hv_proj_xxxx"
      }
    }
  }
}
```

Claude Code then calls `POST /api/mcp` with the standard streamable-HTTP MCP
envelope, expecting an `application/json` or `text/event-stream` response
depending on the request.

---

## Scope

### In scope

- `GET /api/mcp` — MCP `initialize` / capability discovery  
- `POST /api/mcp` — tool calls (streamable HTTP, JSON or SSE body)  
- Tool catalogue (see §Tools below)  
- API-key auth scoped to a Project  
- `GET /api/mcp/config-snippet` — returns a ready-to-copy JSON snippet for
  `.claude/settings.local.json`  
- Marketplace skill pack type `claude_code_plugin` (new `pack_type` value)  
- Automated `npx @harmoven/claude-code-plugin` bootstrapper (future, not v1)

### Out of scope (future)

- Stdio transport (Claude Code's default for local servers; lower priority since
  Harmoven is typically remote)
- Claude Code hook-based triggers (start/stop run on Git events)
- NPM package `@harmoven/claude-code-plugin`

---

## Tools catalogue

Each tool is exposed under the `harmoven` namespace. Claude Code displays them
as `harmoven__<tool>`.

| Tool | Description | Key inputs | Key outputs |
|------|-------------|------------|-------------|
| `list_pipelines` | List available pipelines in the project | `page`, `q` | array of `{id, name, description}` |
| `get_pipeline` | Get a pipeline's full definition | `pipeline_id` | pipeline YAML/JSON definition |
| `trigger_run` | Start a pipeline run | `pipeline_id`, `context` (free JSON), `label?` | `{run_id, status, url}` |
| `get_run` | Get run status and node states | `run_id` | run object with node snapshots |
| `list_runs` | List recent runs | `pipeline_id?`, `status?`, `page` | paginated run list |
| `get_run_output` | Retrieve final agent output for a run | `run_id` | `{output, status, cost_usd}` |
| `list_gates` | List pending human gates | `run_id?` | array of open gates |
| `approve_gate` | Approve a human gate | `gate_id`, `comment?` | `{success, run_status}` |
| `reject_gate` | Reject a human gate | `gate_id`, `reason` | `{success, run_status}` |
| `get_run_logs` | Stream agent step logs for a run | `run_id`, `node_id?` | SSE stream of log lines |

All tools require `runs:read` permission minimum. Write tools (`trigger_run`,
`approve_gate`, `reject_gate`) require `runs:create` / `gates:approve`.

---

## Data model changes

### `ProjectApiKey` — existing model, no schema change

API keys already exist (`ProjectApiKey`). The MCP endpoint authenticates via
the existing key mechanism. No new Prisma model is needed.

### `pack_type` enum — extend `InstalledPack`

Add `claude_code_plugin` to the existing `pack_type` enum (or string field):

```prisma
// If pack_type is a plain String, no migration needed — only manifest validation changes.
// If it is a DB enum, add the value:
enum PackType {
  skill
  pipeline_template
  claude_code_plugin   // NEW
}
```

---

## API routes

### `GET /api/mcp`

Returns MCP server capabilities (JSON). Does not require auth (capability
discovery is public, like openAPI spec).

Response:
```json
{
  "protocol_version": "2025-03-26",
  "server_info": { "name": "harmoven", "version": "1.0" },
  "capabilities": { "tools": {} }
}
```

### `POST /api/mcp`

Handles all MCP JSON-RPC requests. Auth required via `Authorization: Bearer`.

- Parse `Content-Type: application/json` body as JSON-RPC 2.0 envelope.
- Dispatch to tool handler based on `method` field (`tools/call`, `tools/list`).
- For `get_run_logs`: respond with `Content-Type: text/event-stream` (SSE).
- For all other tools: respond with `Content-Type: application/json`.
- Return `{"error": {"code": -32001, "message": "Unauthorized"}}` on auth
  failure — never a plain HTTP 401 (MCP requires JSON-RPC error format).

Input validation: Zod schema per tool, same pattern as existing API routes.

### `GET /api/mcp/config-snippet`

Auth required (any valid project API key). Returns the JSON snippet to paste
into `.claude/settings.local.json`:

```json
{
  "snippet": {
    "mcpServers": {
      "harmoven": {
        "type": "http",
        "url": "https://<instance-url>/api/mcp",
        "headers": { "Authorization": "Bearer <this-key>" }
      }
    }
  },
  "instructions": "Paste into .claude/settings.local.json"
}
```

---

## Marketplace skill pack — `claude_code_plugin` type

A new pack type that, when installed, auto-registers the Harmoven MCP server in
Claude Code project settings.

### Pack manifest additions

```yaml
pack_id: harmoven-claude-code
pack_type: claude_code_plugin
name: Harmoven for Claude Code
version: "1.0.0"
author: harmoven
description: >
  Native Harmoven integration for Claude Code.
  Adds pipeline, run and gate management tools to your Claude Code session.
tags: [claude-code, mcp, pipelines]
claude_code:
  server_name: harmoven
  transport: http
  url_template: "{{HARMOVEN_URL}}/api/mcp"
  # Variables that the installer must resolve before writing settings
  required_env:
    - name: HARMOVEN_URL
      label: "Harmoven instance URL"
      description: "Base URL of your Harmoven instance, e.g. https://harmoven.example.com"
    - name: HARMOVEN_API_KEY
      label: "Project API key"
      description: "Project API key (hv_proj_…)"
      secret: true
```

### Installer behaviour (lib/marketplace/install-pack.ts extension)

When `pack_type === 'claude_code_plugin'`:

1. Prompt user for `required_env` variables (UI in marketplace install dialog).
2. Resolve `url_template` with provided values.
3. Write / merge the `mcpServers` entry into `.claude/settings.local.json` in
   the user's current project root (if running in Electron) or display the
   ready-to-copy snippet (if running as web app).
4. Store the pack as `InstalledPack` with `pack_type = 'claude_code_plugin'`.
5. **Security**: never write `HARMOVEN_API_KEY` to a committed file —
   always write to `.claude/settings.local.json` (gitignored by Claude Code by
   default).

---

## Security considerations

| Risk | Mitigation |
|------|-----------|
| SSRF via `url_template` | Validate against existing SSRF guard (`lib/security/`) before resolving |
| API key leakage in logs | Never log the `Authorization` header value |
| Prompt injection via tool outputs | Wrap external data in `<TOOL_RESULT>` tags (existing pattern in `lib/mcp/client.ts`) |
| Gate approval CSRF | Require re-auth confirmation for `approve_gate`/`reject_gate` if session is older than 15 minutes |
| Overwriting existing Claude Code settings | Merge (not overwrite) `mcpServers` key; error if key `harmoven` already exists with different url |
| API key in `.claude/settings.local.json` | Add `.claude/settings.local.json` to the generated `.gitignore` snippet shown to the user |

---

## Acceptance criteria

- [ ] `GET /api/mcp` returns valid MCP capability JSON — no auth required
- [ ] `POST /api/mcp` with valid API key and `tools/list` method returns all 9 tools
- [ ] `POST /api/mcp` without auth returns JSON-RPC error `{code: -32001}`
- [ ] `trigger_run` starts a real pipeline run and returns a `run_id`
- [ ] `approve_gate` / `reject_gate` change gate and run status in DB
- [ ] `get_run_logs` responds with `text/event-stream` content type
- [ ] `GET /api/mcp/config-snippet` returns correct snippet with real instance URL
- [ ] `install-pack.ts` handles `pack_type = 'claude_code_plugin'` without crash
- [ ] API key is written only to `.claude/settings.local.json`, never to committed files
- [ ] All tool inputs validated by Zod — malformed input returns `{code: -32602}`
- [ ] `npx tsc --noEmit` passes with zero errors
- [ ] `openapi/v1.yaml` updated with `/api/mcp` and `/api/mcp/config-snippet`

---

## Implementation plan

### Phase 1 — MCP server endpoint (no UI)

1. `app/api/mcp/route.ts` — GET (capabilities) + POST (tool dispatcher)
2. `lib/mcp/server/` — tool handlers (one file per domain: pipelines, runs, gates)
3. `lib/mcp/server/auth.ts` — API key extraction + permission resolution
4. `lib/mcp/server/types.ts` — JSON-RPC envelope types + tool input schemas (Zod)
5. Unit tests: `tests/mcp/server/` — mock DB, test each tool handler
6. `openapi/v1.yaml` — document `/api/mcp` (both methods)

### Phase 2 — Config snippet endpoint + i18n

1. `app/api/mcp/config-snippet/route.ts`
2. `locales/en.json` + `locales/fr.json` — marketplace install dialog strings
3. `openapi/v1.yaml` — document `/api/mcp/config-snippet`

### Phase 3 — Marketplace `claude_code_plugin` pack type

1. `lib/marketplace/types.ts` — extend `PackManifest` with `pack_type` and
   `claude_code` fields
2. `lib/marketplace/install-pack.ts` — handle new pack type
3. `app/(app)/marketplace/` — extend install dialog for env-var prompts
4. Prisma: add `claude_code_plugin` to enum if applicable + migration
5. E2E test: install a `claude_code_plugin` pack and verify snippet output

---

## Test plan

| Test | Type | File |
|------|------|------|
| `GET /api/mcp` returns capabilities | Unit | `tests/api/mcp.test.ts` |
| `POST tools/list` authenticated | Unit | `tests/api/mcp.test.ts` |
| `POST tools/list` unauthenticated → JSON-RPC error | Unit | `tests/api/mcp.test.ts` |
| `trigger_run` creates Run in DB | Unit | `tests/mcp/server/runs.test.ts` |
| `approve_gate` updates Gate + Run status | Unit | `tests/mcp/server/gates.test.ts` |
| Zod validation rejects bad input | Unit | `tests/mcp/server/types.test.ts` |
| Install `claude_code_plugin` pack writes correct snippet | Integration | `tests/marketplace/install-pack.test.ts` |
| No secret written to committed file | Integration | `tests/marketplace/install-pack.test.ts` |
| E2E: Claude Code MCP connect → `tools/list` → `trigger_run` | E2E | `tests/e2e/mcp-claude-code.spec.ts` |

---

## Open questions

1. **Stdio transport** — Claude Code defaults to stdio for local servers. We chose
   HTTP for remote Harmoven instances. Should we also ship a thin stdio proxy
   (e.g., `npx @harmoven/mcp-proxy`) for developers running Harmoven locally?

2. **Rate limiting** — Should `/api/mcp` share the existing per-API-key rate
   limiter, or have a separate limit for LLM-driven calls which can be bursty?

3. **Streaming tool output** — MCP spec allows `stream: true` on tool results.
   Is SSE for `get_run_logs` sufficient, or should all tools support streaming
   to surface intermediate agent thought traces?

4. **Multi-project keys** — Current API keys are scoped to one project. Claude
   Code users often work across projects. Should we add an instance-scoped API
   key type that targets a specific project via a `project_id` tool parameter?
