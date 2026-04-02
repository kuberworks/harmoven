---
title: "Marketplace v2 — Admin configuration, registry browser, Git import, package upload"
status: todo
created: 2026-04-01
depends_on: ["harmoven-v1-implementation.feature.md", "feat/github-url-import"]
---

## Overview

Complete overhaul of the Harmoven marketplace and plugin management system.
The feature has two distinct surfaces:

- **Part A — Admin settings** (`/admin/marketplace`): instance-admin-only configuration
  of trusted git URL patterns and remote registry feed URLs.
- **Part B — Marketplace UI** (`/marketplace`): user-facing tabs to browse registry
  plugins, import from a Git source, and upload a local Harmoven package.

Detection and safety scanning are **static and rule-based** — no AI/LLM call is made
in the detection pipeline. The optional **Smart Import** feature (A.4) may invoke a
configured LLM after static detection completes, only when explicitly enabled and
requested by an admin.

---

## Part A — Admin: Marketplace Settings

### A.1  Navigation

Add a **Marketplace** entry to the existing Admin sidebar (between "Skills" and
the last item). Route: `/admin/marketplace`. Protected by `assertInstanceAdmin()`.
The page has two sub-sections rendered as cards or tabs:

1. **Git URL whitelist** — which git hosts / URL patterns are allowed as import sources.
2. **Registry feeds** — which remote marketplace URLs are polled to list installable plugins.

---

### A.2  Git URL Whitelist Management

#### A.2.1  Data model — `GitUrlWhitelistEntry`

```prisma
model GitUrlWhitelistEntry {
  id          String   @id @default(uuid())
  label       String   // human name, e.g. "Internal GitLab"
  pattern     String   // hostname or glob, e.g. "github.com" | "*.internal.corp"
  description String?
  enabled     Boolean  @default(true)
  created_by  String
  created_at  DateTime @default(now())
  updated_at  DateTime @updatedAt
}
```

Default seeded entries (non-deletable, `is_builtin = true` — add column):
- `github.com`
- `raw.githubusercontent.com`
- `api.github.com`
- `gitlab.com`
- `bitbucket.org`

#### A.2.2  API routes

| Method | Path | Action |
|--------|------|--------|
| GET    | `/api/admin/marketplace/git-whitelist` | List (paginated, searchable) |
| POST   | `/api/admin/marketplace/git-whitelist` | Create entry |
| PATCH  | `/api/admin/marketplace/git-whitelist/:id` | Update label/pattern/enabled |
| DELETE | `/api/admin/marketplace/git-whitelist/:id` | Delete (reject if is_builtin) |

**GET query parameters** (all optional):
- `page` (int, default 1), `size` (int, default 20, max 100)
- `q` (string, search on `label` + `pattern`)
- `sort` (`label` | `pattern` | `created_at`, default `created_at`)
- `order` (`asc` | `desc`, default `desc`)
- `enabled` (`true` | `false` | omit = all)

#### A.2.3  Validation rules

- `pattern` must be a valid hostname or glob (`*.example.com`) — reject bare IPs,
  CIDR ranges, `localhost`, `127.*`, `10.*`, `172.16–31.*`, `192.168.*`.
- `pattern` max length 253 (max FQDN length). `label` max 128. `description` max 512.
- `pattern` is checked with the same logic as `assertAllowedHost()` in
  `lib/marketplace/from-github-url.ts` — deduplicate the whitelist check function.

#### A.2.4  Security

- All state-changing routes must verify `assertInstanceAdmin()`.
- Zod-validate all inputs; return opaque errors to client.
- AuditLog every create/update/delete/enable/disable with `action_type`:
  `marketplace_whitelist_created | _updated | _deleted | _toggled`.
- Pattern matching at import time uses `micromatch` (already a transitive dep) —
  **never** DNS resolve patterns; match on parsed hostname string only.

---

### A.3  Registry Feed Management

#### A.3.1  Data model — `MarketplaceRegistry`

```prisma
model MarketplaceRegistry {
  id           String    @id @default(uuid())
  label        String    // human name, e.g. "Harmoven Official"
  feed_url     String    // HTTPS URL pointing to a JSON or YAML registry index
  auth_header  String?   // Optional: "Bearer <token>" — stored encrypted (AES-256-GCM)
  enabled      Boolean   @default(true)
  is_builtin   Boolean   @default(false)
  last_fetched_at DateTime?
  last_fetch_status String? // "ok" | "error: <opaque code>"
  created_by   String
  created_at   DateTime  @default(now())
  updated_at   DateTime  @updatedAt
}
```

Default seeded entry (non-deletable, `is_builtin = true`):
- Label: "Harmoven Official", URL: `https://marketplace.harmoven.com/index.json`

#### A.3.2  Registry feed format (canonical spec)

A registry feed is a JSON or YAML document served at the configured URL.
Two formats are accepted:

**Format A — top-level object (preferred)**

```json
{
  "schema_version": "1",
  "generated_at": "2026-04-01T00:00:00Z",
  "plugins": [
    {
      "id": "invoice_followup_fr",
      "name": "Invoice Follow-up (FR)",
      "version": "1.2.0",
      "author": "ACME Corp",
      "description": "Automated invoice follow-up in French.",
      "tags": ["finance", "fr"],
      "capability_type": "domain_pack",
      "download_url": "https://example.com/packs/invoice_followup_fr-1.2.0.hpkg",
      "content_sha256": "abc123...",
      "homepage_url": "https://github.com/acme/invoice-followup",
      "license": "MIT",
      "min_harmoven_version": "1.0.0"
    }
  ],
  "total": 1,
  "page": 1,
  "per_page": 50
}
```

**Format B — top-level array (legacy, still accepted)**

```json
[{ "id": "...", "name": "...", ... }]
```

Each plugin entry must have at minimum: `id`, `name`, `version`, `capability_type`.
All other fields are optional but displayed when present.

`capability_type` must be one of:
`domain_pack | mcp_skill | harmoven_agent | js_ts_plugin`

#### A.3.3  API routes

| Method | Path | Action |
|--------|------|--------|
| GET    | `/api/admin/marketplace/registries` | List (paginated) |
| POST   | `/api/admin/marketplace/registries` | Add registry |
| PATCH  | `/api/admin/marketplace/registries/:id` | Update |
| DELETE | `/api/admin/marketplace/registries/:id` | Delete (reject if is_builtin) |
| POST   | `/api/admin/marketplace/registries/:id/test` | Test-fetch the feed → return count or error |

**GET query parameters**: `page`, `size`, `q` (search on `label` + `feed_url`),
`sort` (`label` | `created_at`), `order`, `enabled`.

#### A.3.4  Validation and security

- `feed_url` must be HTTPS, max 2048 chars.
- `feed_url` hostname must not resolve to a private IP range (RFC 1918 / loopback) —
  SSRF prevention: call `assertNotPrivateHost()` (already exists in `lib/marketplace/install-pack.ts`)
  before any fetch.
- **DNS rebinding mitigation**: resolve the hostname once, pin the resolved IP, and pass the pinned
  IP address (with `Host` header) to the actual fetch. Do not resolve again between check and fetch.
  Same pinning requirement applies to all external fetches: `download_url`, GitHub API calls,
  raw content requests.
- `auth_header` stored encrypted with AES-256-GCM (same as `ProjectCredential.value_enc`).
  Never returned in GET responses — return `has_auth: true/false` instead.
- Feed fetch: `redirect: 'error'`, `AbortSignal.timeout(10_000)`, max 5 MB response,
  Content-Type must be `application/json` or `application/yaml` or `text/yaml`.
- YAML parsed with `{ schema: yaml.JSON_SCHEMA }` (same as existing from-github-url.ts rule).
- JSON parsed via `JSON.parse` — reject if result is not array or object.
- Each plugin entry validated with a Zod schema before touching the DB.
- AuditLog every create/update/delete/test with `action_type`:
  `marketplace_registry_created | _updated | _deleted | _tested`.

---

### A.4  Smart Import — Relevance Gate & LLM Adapter

Two complementary features that run **after** B.2.3 static detection and **before** any DB write,
for every "Add from Git" import request, when Smart Import is enabled:

1. **Relevance gate** (A.4.6) — runs only when Smart Import is enabled. Uses the LLM to determine
   whether the repo brings meaningful capability to Harmoven before any conversion is attempted.
   Produces `{ relevant, confidence, risks[], capability_summary }` shown to the admin.
   Admin must explicitly confirm when confidence is low or relevance is negative.
   If the LLM call fails for any reason (quota, timeout, parse error, budget), the gate is skipped
   with a visible warning; admin proceeds via "Importer sans analyse LLM" (SEC-51).

2. **LLM adapter** — optional, only when Smart Import is enabled AND the repo passed the relevance
   gate. Converts detected content to a structured declarative Harmoven manifest for admin review.
   **Declarative output only in v2 — no executable code generated.**

#### A.4.1  Configuration (stored in `InstanceSetting`)

| Key | Type | Description |
|---|---|---|
| `marketplace.smart_import.enabled` | `boolean` | Master switch — default `false` |
| `marketplace.smart_import.provider_id` | `string` | FK to `LlmProvider` (admin-configured providers) |
| `marketplace.smart_import.model` | `string` | Model name within the provider |
| `marketplace.smart_import.max_tokens` | `int` | Max tokens per import call — default 4000 |
| `marketplace.smart_import.preview_ttl_hours` | `int` | TTL for `GitHubImportPreview` records — default `24`, min `1`, max `168` (7 days). Applies to both smart import previews and manual update-check previews. See note on admin deactivation in A.4.5 (L16). (V12) |
| `marketplace.smart_import.monthly_budget_usd` | `number \| null` | Monthly spend cap in USD across all admins — `null` = unlimited (default). When set, a soft alert is triggered at 80% usage; hard block at 100% (returns HTTP 402 `BUDGET_EXCEEDED`). Override requires `marketplace:admin` role AND explicit checkbox — not available to standard instance admins (L5). **Budget period**: calendar month, evaluated as `SUM(cost_usd)` from AuditLog phantom runs where `created_at >= first day of current UTC month 00:00:00Z`. Resets automatically at `00:00:00 UTC on the 1st` of each calendar month — no cron needed, computed at query time. (L11) |
| `marketplace.import.require_import_reason` | `'never' \| 'p3_and_overrides' \| 'always'` | Controls when Step 3 prompts for a free-text audit reason: `never` = field hidden (default); `p3_and_overrides` = required for `js_ts_plugin` imports and relevance gate overrides; `always` = required for every import. **Independent of LLM config** — applies even when Smart Import is disabled. Enforced server-side in `POST /api/admin/skills/from-url/approve` and `POST /api/admin/marketplace/upload` via `assertImportReasonRequired()` — not client-enforced only (L6). |

UI: new card **"Smart Import (LLM)"** in `/admin/marketplace`. Dropdowns populate
from the same provider list as Admin > LLM settings. Only super-admins with
`marketplace:admin` can change these settings.

#### A.4.2  Cost tracking — phantom run

Every smart import LLM call is recorded as a **phantom run**:

```
project_id   = "__system__"      // reserved pseudo-project, auto-created on first use
run_type     = "marketplace_import"
triggered_by = <admin userId>
```

Phantom runs reuse the existing `Run` + `RunToken` (cost) schema — no new table.
The `RunToken` record captures `input_tokens`, `output_tokens`, `cost_usd`, `provider`, `model`.

The `__system__` project is created via **`upsert`** (find-or-create by `id = "__system__"`,
idempotent) — never a bare `create`. Concurrent phantom runs cannot produce duplicate system projects.

**Visibility gate**: phantom runs of type `marketplace_import` are **excluded from all
normal run list queries**. They are only accessible via:
- `GET /api/admin/marketplace/import-history` — requires `marketplace:admin` permission
- Admin > Marketplace > "Import history" tab

The import history view shows: date, admin user, source URL, detected type, model used,
input/output tokens, cost, and outcome (pipeline template created / skipped / failed).
A monthly cost aggregate is displayed at the top of the tab, compared against
`monthly_budget_usd` when set: *"$12.40 / $50.00 (24%)"* with a progress bar turning
🟡 at 80% and 🔴 at 100%. This is the canonical budget visibility surface outside the import
flow — no separate dashboard widget needed. (U6)

#### A.4.3  RBAC for cost visibility

| Permission | Granted to | Scope |
|---|---|---|
| `marketplace:admin` | Instance admins | Full access: import, configure LLM, view all import history + costs |
| `marketplace:import_costs:own` | (reserved, v3) | Own import history only |

The `import-history` endpoint enforces `assertInstanceAdmin()`. No cost data
leaks through any other API surface.

#### A.4.4  Smart import flow

```
Admin submits URL
  → B.2.3 static detection (always, no LLM)
  → A.4.6 relevance gate (LLM ON only — skipped if Smart Import disabled)
      LLM call: { structure_summary, readme_excerpt, detected_type } → { relevant, confidence, risks[], capability_summary }
      └─ LLM errors (rate limit 20/day, provider 429, timeout, Zod parse failure, context overflow):
             ⚠ banner "Analyse de pertinence indisponible — [raison courte]"
             → "Importer sans analyse LLM" button; gate skipped; proceed to naïve import
             → Phantom run recorded with outcome: 'error', error_code
         If NOT_RELEVANT (relevant=false, confidence ≥ 0.8):
             🔴 banner shown; admin must check "Je confirme l'import malgré l'avertissement"
                AND provide a free-text reason (logged in AuditLog)
         If UNCERTAIN (relevant=false, confidence < 0.8):
             ⚠ banner shown; admin must check confirmation checkbox
         If RELEVANT: proceed silently
  → If smart import enabled AND repo passed relevance gate AND content warrants LLM adapter:
       → Check monthly budget (A.4.1 `monthly_budget_usd`):
           If usage ≥ 80% → ⚠ banner "Budget mensuel LLM à [X]% — $Y restants"  (non-bloquant)
           If usage ≥ 100% → 🔴 banner "Budget mensuel LLM épuisé"  + "Importer sans LLM" button
                             `marketplace:admin` can override with explicit checkbox "Je confirme l'import hors budget"
                             (AuditLogged with `BUDGET_OVERRIDE`); standard admins see block only (HTTP 402)
                             Override availability checked server-side in `analyze-command` route (L5)
       → Show: "Analyser avec LLM: [auto-sélectionné: provider/model]  ~$0.003 estimé"
           Auto-selection: iterate LlmProviders ordered by (context_window DESC, cost_per_token ASC)
           — select cheapest model that fits estimated_tokens:
             < 2 000 tokens  → flash/mini tier
             2 000–8 000     → balanced tier (sonnet / turbo)
             > 8 000         → large-context tier (opus / gpt-4)
           If no provider covers the required context → fall back to naïve import with warning.
       → Admin confirms
       → POST /api/admin/marketplace/analyze-command  { preview_id }
       → Server looks up GitHubImportPreview by preview_id
       → Re-fetches file server-side, verifies SHA-256 — mismatch = abort (CONTENT_CHANGED)
       → LLM call (phantom run recorded); system prompt: output declarative Harmoven manifest JSON only
       → Returns: { manifest: Harmoven manifest JSON, confidence, cost_usd, tokens_used }
       → Admin reviews; approves / edits / rejects
       → If approved → validate through B.3.2 upload pipeline (double scan + hash-lock)
  → If smart import disabled or admin skips LLM:
       Fall back to naïve import (existing B.2 conversion rules)
```

If smart import is disabled or admin skips it: fall back to naïve import
(body of `.md` as prompt template, `capability_type = slash_command`, no pipeline template).

**UI when Smart Import is disabled (U12)**: when `marketplace.smart_import.enabled = false`
(the default for all new deployments), the Add from Git tab shows a collapsed info card below
the URL field:
> *"Smart Import (analyse LLM) est désactivé. L'import utilisera la détection statique uniquement.
>  [Activer dans Admin → Marketplace →]"*

The link navigates to `/admin/marketplace#smart-import`. The import flow still works fully
(static detection + naïve conversion). No LLM budget check, no relevance gate. The info card
is dismissible per-session (localStorage key `smart_import_hint_dismissed`).

#### A.4.5  Smart import security constraints

- **Rate limit**: 20 smart import LLM calls per `userId` per day (tracked via AuditLog COUNT,
  separate from the B.2 repo analysis rate limit). Exceeding returns HTTP 429.
- **No client-supplied hash or content**: the `analyze-command` route accepts only an opaque
  `preview_id`. The SHA-256 reference value is read from the `GitHubImportPreview` DB record,
  never from the request body. The file is re-fetched server-side and verified against the DB value
  before sending anything to the LLM (see A.4.4).
- **`preview_id` ownership check**: before any processing, verify `preview.created_by === session.userId`.
  If the `preview_id` was created by a different admin, reject with HTTP 403 (`PREVIEW_NOT_OWNED`).
  Prevents cross-admin IDOR attacks on the preview queue (SEC-40).
- **Preview TTL**: `GitHubImportPreview` records expire after **24 hours** (configurable:
  1 h–7 d via `marketplace.smart_import.preview_ttl_hours` instance setting).
  Submitting an expired `preview_id` returns HTTP 410 `GONE` (SEC-41).
- **TTL and admin deactivation (L16)**: if an admin account is deactivated, their active
  `GitHubImportPreview` records are **not automatically invalidated** by this spec — that
  is handled by the session revocation layer (out of scope for marketplace v2). Operators
  should set `preview_ttl_hours = 1` on high-security instances where session revocation
  is not guaranteed or where maximum TTL is 7 days. The spec **recommends** `preview_ttl_hours ≤`
  the instance's session lifetime. No automatic cleanup of previews on admin deactivation
  is required in v2 — deferred to v3 admin lifecycle management.
- **Content size cap**: the fetched content is truncated at `max_tokens × 3`
  characters before the API call. Content is never sent raw without this cap.
- **Prompt injection via slash command body**: the command content is adversarial by assumption.
  The system prompt sent to the LLM must instruct it to output **only** a JSON object matching
  the pipeline DAG schema and to ignore any instructions embedded in the command body.
  Response must be parsed with `JSON.parse` + Zod; any parse failure = fall back to naïve import.
- **No auto-save**: the LLM output is shown to the admin for review and never written to the DB
  without an explicit approval action (SEC-22 applies).

#### A.4.6  Relevance gate

Determines whether a repo brings meaningful capability to Harmoven before any conversion or LLM
adapter is invoked. Runs **only when Smart Import is enabled**.

**Scope of analysis**:
- README.md first **2 000 characters** (fetched as a single additional request if found in listing)
- Manifest `description` and `name` fields already retrieved by B.2.3
- File extension histogram from the directory listing
- Detected `capability_type` from B.2.3

**LLM call**

Uses the auto-selected model (A.4.4), cheapest tier.
Input: `{ structure_summary, readme_excerpt, detected_type }` — never full file contents.
System prompt instructs LLM to return only:
```json
{ "relevant": true, "confidence": 0.92, "reasoning": "string", "risks": ["string"], "capability_summary": "string" }
```
Zod-validated. Three outcomes:
- `relevant = true` → `RELEVANT` — proceed silently
- `relevant = false` AND `confidence < 0.8` → `UNCERTAIN` — `⚠ Pertinence incertaine` banner; admin must confirm
- `relevant = false` AND `confidence ≥ 0.8` → `NOT_RELEVANT` — `🔴` banner; admin must confirm AND provide free-text reason (AuditLogged)

Cost counted against A.4 rate limit (20 calls/user/day). Phantom run recorded with `outcome: 'relevance_gate'`.

**Error handling**

All error cases produce a visible inline banner and an **"Importer sans analyse LLM"** button.
The gate is skipped — never silently bypassed — and the admin proceeds to naïve import.

| Error | `error_code` in phantom run | Banner message |
|---|---|---|
| Rate limit 20/user/day | `RATE_LIMIT_EXCEEDED` | *"Limite journalière d'analyse atteinte (20/20)."* |
| Provider 429 quota | `PROVIDER_QUOTA_EXCEEDED` | *"Le provider LLM a retourné une erreur de quota."* |
| Provider 5xx / timeout | `PROVIDER_UNAVAILABLE` | *"L'analyse LLM a échoué (erreur temporaire)."* |
| Zod / JSON parse failure | `LLM_PARSE_ERROR` | *"La réponse LLM n'a pas pu être interprétée."* |
| Context overflow (no model covers token count) | `CONTEXT_OVERFLOW` | *"Le contenu dépasse la capacité de tous les modèles configurés."* |
| No provider configured | — (button disabled pre-flight) | Config card shows validation error; "Analyser" button disabled |

Failed calls are still recorded as phantom runs with `outcome: 'error'` and `error_code`.

**Important**: README.md content is used **only** for relevance scoring. It is never stored in DB,
never returned verbatim to the client, and never sent to the LLM as part of the adapter step.

**LLM adapter output — declarative manifest fields (V1)**

When the adapter step runs (after relevance gate RELEVANT/confirmed), the LLM is instructed to
output **only** a JSON object conforming to this schema (Zod-validated server-side):

```json
{
  "pack_id": "string (slug /^[a-z0-9_]{1,64}$/)",
  "name": "string (max 128)",
  "description": "string (max 512)",
  "capability_type": "domain_pack | mcp_skill | harmoven_agent | js_ts_plugin",
  "version": "string (semver)",
  "tags": ["string (max 20 × 64 chars)"],
  "prompt_template": "string | null  (domain_pack / slash_command only — max 32768 chars)",
  "allowed_tools": ["string (max 50 × 256 chars)  (slash_command only)"],
  "mcp_server": {
    "command": "string",
    "args": ["string"],
    "env": { "KEY": "string" }
  },
  "agent_config": {
    "steps": [{ "name": "string", "prompt": "string", "tools": ["string"] }],
    "max_iterations": "number | null"
  },
  "confidence": 0.0
}
```

Field presence is typed per `capability_type`:
- `domain_pack` / `slash_command`: `prompt_template` required, others null/absent
- `mcp_skill`: `mcp_server` required (`command` + optional `args`/`env`), others absent
- `harmoven_agent`: `agent_config` required (`steps[]` minimum), others absent
- `js_ts_plugin`: no content fields — manifest metadata only

**`mcp_server.command` safeguard (L9)**: `command` is Zod-validated against a known-safe
allowlist: `["npx", "node", "uvx", "python", "python3", "deno", "bun"]`.
A value outside this list does **not** cause Zod rejection (the manifest is admin-reviewed)
but triggers a `⚠ Commande inhabituelle` badge in the review UI and requires an explicit
admin confirmation checkbox before approval — same friction as `js_ts_plugin`. (SEC-54)

**`mcp_server.args` constraints (L13)**: Zod validates at parse time:
- Max **20 entries** in the `args` array → excess: Zod rejection `ARGS_TOO_MANY`.
- Each arg max **256 characters** → excess: Zod rejection `ARG_TOO_LONG`.
- Deny-list of dangerous flags: `--eval`, `-e`, `--require`, `-r`, `--import`,
  `--inspect`, `--inspect-brk`, `--inspect-port`, `--allow-all`, `--allow-run`,
  `--loader`, `--experimental-loader` → any match: Zod rejection `UNSAFE_ARG`.
Zod rejection on `args` → falls back to naïve import (same as Zod parse failure). (SEC-59)

**`mcp_server.env` constraints (L10)**: Zod validates at parse time:
- Max **20 entries** in the `env` object → excess: Zod rejection `ENV_TOO_MANY_KEYS`.
- Key max **64 characters** → excess: Zod rejection `ENV_KEY_TOO_LONG`.
- Value max **512 characters** → excess: Zod rejection `ENV_VALUE_TOO_LONG`.
- Deny-list of dangerous system keys: `LD_PRELOAD`, `LD_LIBRARY_PATH`,
  `DYLD_INSERT_LIBRARIES`, `DYLD_FORCE_FLAT_NAMESPACE`, `PATH`, `PYTHONPATH`,
  `NODE_PATH` → any match: Zod rejection `UNSAFE_ENV_KEY`.
Zod rejection on `env` → falls back to naïve import (same as Zod parse failure). (SEC-55)

The system prompt includes the full schema and instructs the LLM to omit keys not applicable
to the detected `capability_type`. Extra keys → Zod rejection. All fields shown to admin
for review and editable before approval. Zod parse failure → naïve import fallback (A.4.4). (V6+V7)

---

### A.5  Git Provider Token Management

Allows instance admins to configure access tokens for private Git repositories on any supported
provider (GitHub, GitLab, Bitbucket, or any self-hosted instance on the whitelist).
These tokens are used for all server-side Git API/content fetches (B.2, B.4, B.5).

#### A.5.1  Data model — `GitProviderToken`

```prisma
model GitProviderToken {
  id           String    @id @default(uuid())
  label        String    // human name, e.g. "GitHub (ACME org)"
  host_pattern String    // hostname or glob matching the provider
  token_enc    String    // AES-256-GCM encrypted token — never returned via API
  enabled      Boolean   @default(true)
  expires_at   DateTime? // optional: admin-declared token expiration date
  created_by   String
  created_at   DateTime  @default(now())
  updated_at   DateTime  @updatedAt

  @@unique([host_pattern])
}
```

**Supported providers out of the box** (label presets in UI, admin can override):
- **GitHub** — `github.com`, `api.github.com`, `raw.githubusercontent.com` (Personal Access Token or fine-grained PAT)
- **GitLab** — `gitlab.com` or self-hosted `*.gitlab.*` (Project/Group access token)
- **Bitbucket** — `bitbucket.org` (App password in `user:app_password` format, Base64-encoded as Basic auth)
- **Generic** — any whitelisted hostname (bearer token or `user:token` basic auth)

#### A.5.2  Token resolution priority

For every outgoing Git fetch, the `Authorization` header is resolved in this order:
1. **DB token** matching the request hostname via `micromatch` (most specific pattern wins; disabled tokens skipped)
2. **Env var fallback**: `GITHUB_TOKEN` (github.com), `GITLAB_TOKEN` (gitlab.com), `BITBUCKET_TOKEN` (bitbucket.org)
3. **Anonymous** — no `Authorization` header sent

**Pattern specificity ordering** (L12): when multiple enabled DB tokens match a hostname,
the winner is selected by the following precedence (decreasing):
1. **Exact hostname match** (no wildcard characters) — e.g. `api.github.com`
2. **Glob with one `*`** (single-level wildcard) — e.g. `*.github.com`
3. **Glob with `**`** (multi-level wildcard)
4. **Ties** (same tier, multiple patterns) — `created_at ASC` (oldest entry wins)

`micromatch` is used to test membership, not to sort. Sorting by this precedence is done in
application code before iterating. Disabled tokens are excluded before sorting.

DB tokens always take precedence over env vars for the same host.
Env vars remain active as fallback when no DB token is configured.

#### A.5.3  API routes

| Method | Path | Action |
|--------|------|--------|
| GET    | `/api/admin/marketplace/git-provider-tokens` | List (paginated) — `has_token: true/false`, never raw value |
| POST   | `/api/admin/marketplace/git-provider-tokens` | Create |
| PATCH  | `/api/admin/marketplace/git-provider-tokens/:id` | Update label/pattern/enabled |
| DELETE | `/api/admin/marketplace/git-provider-tokens/:id` | Delete |
| POST   | `/api/admin/marketplace/git-provider-tokens/:id/test` | Test-fetch provider API root → return rate-limit headers or error |

#### A.5.4  Security

- `token_enc` stored encrypted with AES-256-GCM (same as `ProjectCredential.value_enc`).
  **Never returned** in GET responses — return `has_token: true/false` only (SEC-46).
- `host_pattern` must match an existing `GitUrlWhitelistEntry` — cannot configure a token
  for a host not already whitelisted.
- `label` max 128 chars, `host_pattern` max 253 chars. Zod-validate all inputs.
- AuditLog every create/update/delete/test: `marketplace_git_token_created | _updated | _deleted | _tested`.
- Test endpoint verifies the token by calling the provider's API verification endpoint only
  (`GET /user` for GitHub, `GET /api/v4/user` for GitLab, `GET /2.0/user` for Bitbucket)
  and returns HTTP status + `X-RateLimit-*` headers only — no personal data forwarded to client.
- `expires_at`: optional ISO date accepted on POST/PATCH. GET returns computed
  `expiry_status: 'valid' | 'expiring_soon' | 'expired'` (`expiring_soon` = within 30 days).
  An expired or expiring-soon token shows a badge on the token list and a dashboard notification:
  *"Token Git « GitHub (ACME) » expire dans 5 jours"* / *"Token Git « … » a expiré"* (SEC-52).

---

## Part B — Marketplace UI

Route: `/marketplace` (already exists). Replace or extend current single page with
**three tabs**: Browse, Add from Git, Upload Package.

---

### B.1  Tab 1 — Browse

- Displays plugins fetched from all enabled `MarketplaceRegistry` entries.
- **Pagination**: server-side via registry `page`/`per_page` parameters (Format A supports it;
  Format B legacy arrays are paginated locally up to 200 entries max — a warning badge shows
  *"Format legacy — pagination non disponible"* if the feed returns > 200 items). (V5)
  Client-side search (filter by name/tags) and sort (name, version, capability_type, install_count).
- **Cache revalidation after registry changes (U14)**: the Browse tab data is fetched
  server-side with a Next.js `revalidateTag('marketplace-browse')` cache tag. The
  `POST /registries` and `PATCH /registries/:id` (enable/disable) route handlers call
  `revalidatePath('/marketplace')` (or `revalidateTag`) after a successful write.
  This ensures the Browse tab reflects new registries without a hard browser reload.
- **Empty state A**: no enabled registry configured →
  *"No marketplace registry is configured. Ask your administrator to add one in Admin → Marketplace."*
- **Empty state B**: registry configured but returns 0 plugins →
  *"No plugins available. The registry returned an empty catalogue."*
- **Empty state C**: all registry fetches failed →
  *"Could not reach the marketplace registry. Check your connection or contact your admin."*
- Each plugin card shows: name, capability_type badge, version, author, description (truncated),
  tags, install_count (if available), action button "Install".
- Install action: calls the existing pack install flow (POST `/api/admin/skills` or pack install
  endpoint).
  - `download_url` from the feed entry must pass `assertNotPrivateHost()` before any fetch —
    same SSRF check as registry `feed_url`. A feed entry pointing to a private/loopback address
    is rejected with `SSRF_BLOCKED` regardless of whitelist status.
  - If `content_sha256` is present in the manifest entry: verify the downloaded content before install — mismatch = hard reject (`HASH_MISMATCH`).
  - If `content_sha256` is **absent**: display a `⚠ Unverified` badge and require an explicit
    admin confirmation checkbox ("I understand this plugin has not been hash-verified") before install.
    **Never silently install unsigned registry content.**
- Fetching is server-side (Next.js Server Component or Route Handler) — the client never
  directly contacts registry URLs.

---

### B.2  Tab 2 — Add from Git

#### B.2.1  Supported input formats

The admin pastes any of the following; the system normalises before processing:

| Input example | Normalised to |
|---|---|
| `github.com/owner/repo` | `https://github.com/owner/repo` (default branch) |
| `https://github.com/owner/repo` | same, default branch |
| `https://github.com/owner/repo/tree/my-branch` | repo root on `my-branch` |
| `https://github.com/owner/repo/tree/my-branch/path/to/dir` | subdirectory on branch |
| `https://github.com/owner/repo/blob/<ref>/<path>` | `raw.githubusercontent.com/owner/repo/<ref>/<path>` (single-file flow) |
| `https://raw.githubusercontent.com/owner/repo/main/pack.toml` | single file (existing flow) |
| `https://github.com/owner/repo.git` | strip `.git`, treat as repo root |

HTTPS only; `git://` and `ssh://` are rejected.

#### B.2.2  Resolution strategy

**Single file URL** (hostname = `raw.githubusercontent.com`, or normalised from `/blob/<ref>/<path>`):
→ Use existing `previewFromGitHubUrl()` from `lib/marketplace/from-github-url.ts` (no change).
→ **Path hint**: if the normalised path matches `(.*/)?(commands|.claude/commands)/[^/]+\.md$`,
  annotate the result with `{ hint: "claude_command", note: "This file appears to be a Claude Code command — imported as slash_command" }`
  and force `detected_type = slash_command` (not `domain_pack`) — the file is a slash command, not a system prompt.
  Show an `ℹ Inferred` badge in the preview UI.

**Repo / directory / branch URL** (hostname = `github.com`):
→ Convert to GitHub API URL: `https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={branch}`
→ Fetch root directory listing (max 200 entries, 1 API call for the root).
→ Run **static type detection** on the file list (see B.2.3).
→ If a single manifest file is identified, fetch it and run remaining existing flow.
→ **Subdirectory fetching for Priority 4**: if the root listing contains `commands/`,
  `.claude/commands/`, or `.claude/hooks/` entries of type `dir`, make additional
  GitHub Contents API calls for each of those directories (max 1 extra call per dir,
  max 3 extra calls total). Files found in those subdirectories are added to the
  conversion candidate list. These extra calls count toward the overall 10 analyses/h
  rate limit (SEC-07) and each must pass the same `GitUrlWhitelistEntry` + `assertNotPrivateHost()` checks.

Host validation applies the same `GitUrlWhitelistEntry` check as above.

#### B.2.3  Static type detection (no AI)

Detection is a **priority-ordered rule set** applied to the directory file list
(filenames only — no content fetched yet except the selected manifest).
Rules are checked top to bottom; first match wins.

**Priority 1 — Explicit Harmoven manifests (accept)**

| Filename match | Detected type |
|---|---|
| `pack.toml` | `harmoven_pack` |
| `harmoven.toml` | `harmoven_pack` |
| `skill.yaml` / `skill.yml` | `harmoven_mcp_skill` |
| `agent.yaml` / `agent.yml` / `agents.yaml` | `harmoven_agent` |
| `*.hpkg` (file at root) | `harmoven_package` → route to upload flow |

**Priority 2 — MCP skill detection (accept)**

Condition: `package.json` exists AND at least one of:
- `@modelcontextprotocol/sdk` appears in `dependencies` or `devDependencies`
  (fetch and parse `package.json` — single additional request)
- `keywords` array contains `"mcp"` or `"model-context-protocol"`
- `name` field contains `"-mcp"` or `"mcp-"`

→ Detected type: `mcp_skill`

**Priority 3 — Generic JS/TS plugin (conditional accept)**

Condition: `package.json` exists AND `tsconfig.json` or `*.ts` files are present
AND priority 2 did not match.

→ Fetch `package.json` (if not already fetched).
→ Run **static safety check** (see B.2.4) against `package.json` scripts section
  and any `*.sh` / `Makefile` / `.github/workflows/*.yml` files visible in the listing.
→ If safety check passes → detected type: `js_ts_plugin` (conditional accept — admin must confirm).
→ If safety check fails → `UNSAFE_PLUGIN` rejection.

**Priority 4 — Claude Code plugin (partial conversion)**

Condition: any of the following found in the directory listing:
- `CLAUDE.md` at root
- `.claude/` directory present
- `.claude-plugin/` directory visible in the listing (official Claude Code plugin format)
  → fetch `.claude-plugin/plugin.json` as a secondary request to extract metadata
- `commands/` directory present at root **AND** at least one secondary Claude discriminant:
  - `CLAUDE.md` at root, OR `.claude/` directory present, OR `.claude-plugin/` directory present, OR
  - at least one `commands/*.md` file whose YAML frontmatter contains an `allowed-tools` key
  _(Rationale: `commands/` alone is too common in non-Claude repos — Symfony, CLI tools, Makefile targets, etc. A secondary discriminant is required to avoid false positives — SEC-39)_

Do **not** reject. Instead, inspect the repo contents and convert what is safe:

| Found | Conversion | Notes |
|---|---|---|
| `.claude-plugin/plugin.json` | → extract `name`, `description`, `version`, `author` for the report | Used as metadata only; no direct capability created |
| `CLAUDE.md` | → one `domain_pack` (system_prompt = file content) | Same pipeline as raw-file import |
| `commands/*.md` or `.claude/commands/*.md` | → one **`slash_command`** per file | Frontmatter `allowed-tools` + `description` extracted; `$ARGUMENTS` preserved |
| `.claude/settings.json` → `mcpServers` keys | → pre-fill the Add-from-Git MCP flow for each entry | Admin must initiate each separately |
| `.claude/hooks/*.sh` / `*.bash` / `*.zsh` / `*.fish` | → **always rejected** | Shell hooks — arbitrary execution, no inspection |
| `.claude/hooks/*.py` / `*.rb` / `*.rs` / `*.go` / `*.java` / `*.cs` | → **always rejected** | Non-JS/TS scripting language — reject by default |
| `.claude/hooks/*.js` / `*.ts` / `*.mjs` | → static safety check (B.2.4); **reject if any pattern matches** | One hit = reject the file; not added to conversion |
| `.claude/hooks/<any other extension>` | → **always rejected** | Unknown executable type; reject-first, not allowlist |
| `.claude/hooks/` file with binary magic bytes | → **always rejected** | Non-text content not inspectable |

**`slash_command` capability type** — produced from `commands/*.md` files:
- `command_name`: slugify(filename without `.md`) — invoked as `/<command_name>` at runtime.
  Max length after slugification: **64 characters** — truncate and warn if longer.
- `prompt_template`: the body of the `.md` file (after stripping YAML frontmatter).
  Max stored length: **32 768 characters** — reject (skip item) if larger.
- `arguments_placeholder`: `$ARGUMENTS` — replaced at runtime by the text following the slash command.
  **Escaping**: substitution uses a named-placeholder approach — the user-provided text is injected
  as a quoted value, never as a raw string that could close or escape the surrounding prompt template.
  The runtime layer must treat `$ARGUMENTS` as opaque data, not as a prompt directive.
- `allowed_tools`: array extracted from frontmatter `allowed-tools` field.
  **Max 50 entries**; each entry max 256 characters — excess entries silently truncated and logged.
- `description`: extracted from frontmatter `description` field. Max 512 characters.
- `mcp_dependencies`: any `mcp__*` entries in `allowed-tools` — listed in the conversion report as informational, not auto-resolved.

`allowed_tools` entries containing `Bash(...)` patterns are passed through B.2.4 static safety scan.
If any Bash pattern matches the deny-list, the item is flagged `status: "unsafe"` in the conversion report.

If smart import (A.4) is enabled and the admin opts in, each `slash_command` can additionally
be analysed to produce a **pipeline template** (see A.4.4). This is optional and post-hoc.

**Runtime prompt injection mitigation (post-import):**
The `prompt_template` stored in DB for a `slash_command` is executed at every `/command` invocation.
The import-time B.2.4 scan reduces but cannot eliminate adversarial content.
At runtime, the execution layer must:
- Wrap `prompt_template` in a system-role boundary that the model treats as privileged.
- Inject `$ARGUMENTS` as a user-role segment, structurally separated from the template.
- Never concatenate `prompt_template` and `$ARGUMENTS` as a single flat string.
This is a **runtime requirement** on the execution engine — not enforced at import time.

**Conversion result** returned to the admin as a structured report before any DB write:

```json
{
  "detected_type": "claude_plugin",
  "plugin_metadata": { "name": "code-review", "version": "1.0.0", "author": "Boris Cherny" },
  "converted": [
    { "source": "CLAUDE.md",                  "capability_type": "domain_pack",  "pack_id": "my_repo",        "status": "ready" },
    { "source": "commands/code-review.md",     "capability_type": "slash_command", "command_name": "code-review",
      "description": "Code review a pull request",
      "allowed_tools": ["Bash(gh pr view:*)", "Bash(gh pr diff:*)", "mcp__github_inline_comment__create_inline_comment"],
      "mcp_dependencies": ["mcp__github_inline_comment__create_inline_comment"],
      "status": "ready" },
    { "source": ".claude/commands/fix.md",     "capability_type": "slash_command", "command_name": "fix",        "status": "ready" }
  ],
  "skipped": [
    { "source": ".claude/hooks/pre.sh", "reason": "SHELL_HOOK_REJECTED" }
  ],
  "mcp_servers_detected": [
    { "name": "my-mcp-server", "command": "npx", "args": ["my-mcp-pkg"] }
  ]
}
```

The admin reviews this report in Step 2 of the UI and can:
- Deselect individual items from the conversion list before approving.
- Trigger separate "Add from Git MCP" flows for each detected MCP server.

If the repo has `.claude/` content but **zero** convertible items (e.g. only shell hooks),
return HTTP 422 code `CLAUDE_PLUGIN_NOTHING_CONVERTIBLE` with a clear explanation.

AuditLog `claude_plugin_conversion_started` at analysis time;
`claude_plugin_conversion_approved` (with list of created pack IDs) after approve.

**Priority 5 — Unrecognised / incompatible (reject)**

Condition: none of the above matched, OR the dominant language is not JS/TS
(heuristic: count file extensions; if `.php`, `.rb`, `.go`, `.java`, `.py`, `.rs`,
`.cs` files outnumber `.ts`/`.js` files, classify as incompatible).

→ Detected type: `unrecognized`
→ Rejection: HTTP 422, code `UNRECOGNIZED_REPO`
→ User message: *"This repository does not appear to contain a Harmoven-compatible plugin.
  Supported types: domain pack (pack.toml), MCP skill (package.json + MCP SDK),
  agent definition (agent.yaml), or a JS/TS plugin."*
→ AuditLog technical detail: list of files inspected, extension histogram.

#### B.2.4  Static safety check (no AI)

Applied to `package.json` scripts and visible shell / CI files.
Any positive match triggers `UNSAFE_PLUGIN` rejection.

**Dangerous shell patterns (regex):**
```
rm\s+-rf\s+/
curl\s+.*\|\s*(bash|sh|zsh)
wget\s+.*\|\s*(bash|sh|zsh)
eval\s*\(
exec\s*\(
process\.exit\s*\(
child_process\.(exec|spawn|execSync|spawnSync)\s*\(
require\(['"]child_process['"]\)
__proto__\s*=
Object\.prototype\[
```

**Prompt injection patterns** (in `description`, `README.md` excerpt ≤ **2 000 characters**, `keywords`):

> ⚠ Scope note: the README.md excerpt sent to the relevance gate LLM is up to 2 000 chars (A.4.6).
> The prompt injection scan must cover the same 2 000-char window — not 500 bytes — to ensure
> adversarial content in the README is caught before it reaches the LLM call. (L1)

```
ignore (previous|all) instructions?
you are now
disregard (previous|above|all)
override (system|user) prompt
jailbreak
DAN mode
```

**YAML bomb / JSON bomb protection:**
- File count in listing > 500 → reject (`REPO_TOO_LARGE`)
- Any single file > 1 MB → reject at fetch time (`CONTENT_TOO_LARGE`)
- YAML `&anchor` + `*alias` repeat count > 10 → reject (`YAML_BOMB`)

**Dependency audit:**
- Cross-reference the `dependencies` + `devDependencies` keys against a static
  deny-list of known malicious package names maintained in
  `lib/marketplace/malicious-packages.ts`.
  - **Seed source**: [OSV.dev](https://osv.dev) npm ecosystem advisories + [Socket.dev](https://socket.dev)
    top malicious packages, filtered to packages with confirmed supply-chain attack history (Q1 2026 snapshot).
  - **Refresh**: the file includes a `LAST_UPDATED` constant and a comment pointing to the two sources.
    A lint rule (`scripts/check-malicious-packages-freshness.ts`) warns at build time if
    `LAST_UPDATED` is older than 90 days. Manual update process; no automated pull.
- Any match → reject with `MALICIOUS_DEPENDENCY`.

**Scan scope — B.2.4 applies to all of the following inputs:**
- `package.json` scripts, `pre/post` hooks (Priority 2/3)
- `.github/workflows/*.yml` / `Makefile` / `*.sh` visible in directory listing
- `.claude-plugin/plugin.json` `description` and `name` fields — **prompt injection patterns only**
- Body of each `commands/*.md` file being imported as `slash_command` — **prompt injection patterns only**
- `allowed_tools` Bash patterns from `commands/*.md` frontmatter — **shell injection patterns only**

**Bash pattern parsing for `allowed_tools`:**
The Claude Code `allowed-tools` format is `Bash(command:subcommand:*)`.
Before running shell injection regex, extract the command string using `Bash\(([^)]+)\)` and
test against the deny-list. Do **not** run `\s+`-based patterns directly on the raw value —
colon-separated subcommands (e.g. `gh pr comment:*`) would bypass space-based regexes.

**Double scan for Priority 4 conversions:**
Each file individually fetched during `claude_plugin` conversion (`CLAUDE.md` body, each
`commands/*.md` body, each `.claude/hooks/*.js` considered) must pass `runDoubleScan()`
before being included in the conversion report.
Files that fail the scan are added to `"skipped"` with `reason: "CONTENT_SCAN_FAILED"`,
never silently dropped.

**Hash-lock scope for `claude_plugin`:**
At analysis time, compute and store `{ path, sha256 }` for **every file individually fetched**
(not only the primary manifest).
At approve time, re-fetch each file and verify its SHA-256 before the DB transaction.
Any mismatch → abort the entire transaction with error code `CONTENT_CHANGED`.

#### B.2.5  UI flow

Same 3-step pattern as the existing single-file import:

1. **Step 1 — Input**: URL field + "Analyse" button.
2. **Step 2 — Review**: show detected type, safety scan summary, scaffolded fields
   with `⚠ Inferred` badges. Admin can edit all fields before approving.
   - If `js_ts_plugin`: warning banner *"This is a generic JS/TS plugin. It has not
     been reviewed by the Harmoven team. Activate it with caution."*
   - If `claude_plugin`: show the structured conversion report (converted items,
     skipped items, detected MCP servers). Each convertible item has a checkbox
     (**default unchecked** — admin must explicitly select items to import).
     **"Sélectionner tout" / "Tout désélectionner"** toggle button shown above the list
     when there are ≥ 2 convertible items — selects/deselects all in one click (U2).
     A banner reads: *"This is a Claude Code plugin. The components below have been extracted and
     converted. Shell hooks cannot be imported. Review each item carefully."*
     Skipped items appear in a collapsible "Not imported" section (read-only, with
     reason). Detected MCP servers appear as "Import MCP server →" buttons that
     open the Add-from-Git flow pre-filled for that server entry.
     For each `slash_command` item with non-empty `mcp_dependencies`, display a
     `⚠ MCP requis` badge listing the MCP tool names that do not match any currently
     configured MCP server. This badge is informational — it does not block import —
     but alerts the admin to resolve dependencies before activating the command (SEC-42).
3. **Step 3 — Approve**: same hash-lock (SEC-10) and synchronous AuditLog (SEC-11) as
   the existing single-file flow. For `claude_plugin`, each selected item is created
   as a separate `McpSkill` row inside a **single DB transaction** — partial failure
   rolls back all.
   **Multi-item progress feedback (U15)**: when N ≥ 2 items are selected for import,
   the confirm button becomes a progress indicator showing *"Création en cours… (3 / 7)"*
   updated via a streaming or polling approach. The button is disabled during the operation.
   On success all items are shown as created inline; on partial or full failure the error
   is displayed inline (the transaction rolls back all — no partial state). This prevents
   accidental double-submit on slow instances.
   **`pack_id` collision handling (U13)**: if `pack_id` validation fails at approve time
   with a `UNIQUE_CONSTRAINT` error (duplicate `pack_id`), the server returns HTTP 409
   with `{ error_code: "PACK_ID_CONFLICT", suggested: "<pack_id>_2" }` — the `suggested`
   value appends `_2` (incrementing suffix until free, computed server-side). The Step 3
   form re-opens at the `pack_id` field with the conflict error and suggestion pre-filled.
   Client-side: the `pack_id` field in Step 2 performs debounced async validation
   (`GET /api/admin/marketplace/check-pack-id?id=<slug>`) → `{ available: bool }` —
   showing `⚠ Déjà utilisé` inline before the admin reaches Step 3.
   - **Import reason** (stored in `AuditLog.metadata.import_reason`):
     Controlled by `marketplace.import.require_import_reason` (A.4.1):
     - `'never'` (default): field hidden entirely — no friction.
     - `'p3_and_overrides'`: textarea (max 512 chars) required when `detected_type = 'js_ts_plugin'`
       OR when admin proceeds despite a relevance gate UNCERTAIN/NOT_RELEVANT warning.
       Labelled *"Raison d'import (audit)"* — not optional in those cases.
     - `'always'`: textarea required for every import. Labelled *"Raison d'import (audit)"*.
     Regardless of this setting, overriding a **NOT_RELEVANT** (confidence ≥ 0.8) gate result
     always requires a free-text reason in Step 2 — this is a confirmation of a specific LLM
     signal, not a general audit field, and cannot be disabled.
     - No dedicated DB column — stored exclusively in `AuditLog.metadata`.

Rate limit: 10 repository analysis attempts per userId per hour (same AuditLog
COUNT mechanism as existing `checkRateLimit()`).

#### B.2.6  Git provider token resolution

For every outgoing Git fetch (GitHub API, raw content, GitLab, Bitbucket, or any whitelisted host),
the `Authorization` header is resolved via **A.5.2** (DB token → env var → anonymous).
A valid GitHub token raises the rate limit from 60 to 5 000 requests/hour; GitLab/Bitbucket tokens
unlock private repository access. Tokens are **never** returned to the client, logged, or included
in error responses.

---

### B.3  Tab 3 — Upload Package

#### B.3.1  Package format specification (`.hpkg`)

An `.hpkg` file is a **ZIP archive** (extension `.hpkg` or `.harmoven.zip`)
with the following mandatory structure:

```
manifest.json          ← required
pack.toml              ← required for domain_pack / harmoven_agent
skill.yaml             ← required for mcp_skill (alternative to pack.toml)
README.md              ← optional
examples/              ← optional directory, *.json or *.yaml only
```

**`manifest.json` format:**

```json
{
  "schema_version": "1",
  "capability_type": "domain_pack | mcp_skill | harmoven_agent | js_ts_plugin",
  "pack_id": "my_pack",
  "name": "My Pack",
  "version": "1.0.0",
  "author": "Author Name",
  "description": "Short description (max 512 chars)",
  "tags": ["tag1", "tag2"],
  "harmoven_min_version": "1.0.0",
  "license": "MIT",
  "content_sha256": "<sha256 of pack.toml or skill.yaml contents>"
}
```

**Constraints:**
- ZIP bomb protection: max uncompressed size 10 MB, max 100 files, max nesting depth 2.
- Only these file extensions allowed inside the archive:
  `.json`, `.yaml`, `.yml`, `.toml`, `.md`, `.txt`
- No executable files, no `.js`, `.ts`, `.sh`, `.py` etc. inside the ZIP.
- `content_sha256` in `manifest.json` must match the SHA-256 of the primary definition
  file (`pack.toml` or `skill.yaml`) — verified before any DB write.
- `tags` array: max **20 entries**, each max **64 characters** — excess entries silently
  truncated and logged before any DB write (SEC-43).

#### B.3.2  Upload API

```
POST /api/admin/marketplace/upload
Content-Type: multipart/form-data
  file: <binary .hpkg>
```

- Max file size: 10 MB (enforced at Next.js route level with `export const config`).
- Validation sequence:
  1. Extension check: must be `.hpkg` or `.harmoven.zip`.
  2. Magic bytes check: ZIP signature `50 4B 03 04`.
  3. Unzip with `jszip` (already a dep) — count entries, check depth, check extensions.
     - Reject any entry whose normalised path contains `..` or starts with `/` (path traversal).
     - Reject any entry that is a symlink (`entry.unixPermissions & 0xA000 === 0xA000`).
     - Reject any entry whose name is an absolute Windows path (`C:\...`).
     All three checks must run before any entry is read — fail fast on first violation.
  4. Parse and Zod-validate `manifest.json`.
  5. Verify `content_sha256` against primary definition file.
  6. Run double scan (same `runDoubleScan()` from `lib/marketplace/from-github-url.ts`)
     on the primary definition file contents.
  7. Run **static safety check** (same B.2.4 rules) against manifest description and tags.
  8. On pass: create `McpSkill` row with `enabled: false`, `source_type: 'upload'`.
     Store the SHA-256 of the uploaded `.hpkg` file bytes in `McpSkill.upload_sha256`
     (hash only — the file itself is not persisted). `upload_sha256` is the canonical
     traceability field for `.hpkg` uploads; no separate `scan_report` table is involved. (V13)
  9. Synchronous AuditLog `marketplace_upload_approved`.

- Rate limit: 5 uploads per userId per hour.
- Returns `{ skill_id, message }` on success (same pattern as approve flow).

#### B.3.3  UI

- Drag-and-drop zone + file picker ("Select .hpkg file").
- Shows filename, size, detected `capability_type` from manifest after parsing.
- Single confirmation button — no multi-step review needed (manifest is explicit,
  no inference required).
  If `marketplace.import.require_import_reason` ≠ `'never'` (A.4.1), a
  *"Raison d'import (audit)"* textarea (max 512 chars) is shown above the confirm button
  (required when setting = `'always'`; the `'p3_and_overrides'` value has no effect on upload
  since `.hpkg` uploads have no `js_ts_plugin` detection path). (U8)
- Displays scan result summary on error (opaque to client: only violation count,
  not patterns matched).

---

### B.4  Manual Git update

Applies only to `McpSkill` rows where `source_type = 'git'` (imported via B.2).
Registry-sourced skills are updated via the registry re-fetch cycle (B.1);
uploaded `.hpkg` skills have no source URL and cannot be updated this way.

#### B.4.1  Check for update

Admin clicks **"Vérifier la MàJ"** on an installed skill card in Admin > Skills.

```
POST /api/admin/marketplace/skills/:id/check-update
```

- Reads `source_url` and `source_ref` from the `McpSkill` row.
- Re-runs the same resolution + static detection pipeline as B.2.2–B.2.3
  (whitelist check, `assertNotPrivateHost()`, DNS pinning).
- Fetches the primary file(s) and computes their SHA-256.
- Compares against `installed_sha256` stored on the row.
- Returns:
  ```json
  {
    "up_to_date": false,
    "current_version": "1.0.0",
    "new_version": "1.1.0",
    "changes": [
      { "field": "prompt_template", "old_sha256": "abc...", "new_sha256": "def...", "size_bytes": 4200 },
      { "field": "allowed_tools",   "old": [],             "new": [] },
      { "field": "description",     "old": "...",          "new": "..." }
    ],
    "preview_id": "<opaque server-issued ID>"
  }
  ```
  If `up_to_date: true`, no `preview_id` is returned.

  For large fields (`prompt_template` / `allowed_tools`), `size_bytes` is returned in the change
  entry but full content is **not** included in this response. The diff modal fetches full content
  on demand via a separate read-only endpoint: (U10)

  ```
  GET /api/admin/marketplace/skills/:id/preview-diff?preview_id=<id>&field=prompt_template
  ```
  Returns `{ old: "string", new: "string" }` for that field — verified against the stored
  SHA-256 from the preview record before returning. Requires same ownership check as apply-update.
  Response is never cached — generated fresh on each request.

- `preview_id` follows the same opaque `GitHubImportPreview` pattern as A.4
  (stored in DB with `created_by`, `expires_at`, `sha256` per file).
- Rate limit: **20 update checks** per userId per hour (AuditLog COUNT, separate from
  the B.2 analysis limit).
- AuditLog `marketplace_git_update_checked` with `{ skill_id, up_to_date }`.

#### B.4.2  Apply update

Admin reviews the diff in a modal and clicks **"Appliquer"**.

```
POST /api/admin/marketplace/skills/:id/apply-update
body: { preview_id }
```

- Verify `preview.created_by === session.userId` → HTTP 403 if mismatch (SEC-44).
- Verify preview not expired (24 h TTL, same as SEC-41) → HTTP 410 if expired.
- Re-fetch each changed file server-side; verify SHA-256 matches `preview` record
  — mismatch on any file → abort with `CONTENT_CHANGED`.
- Run `runDoubleScan()` + B.2.4 static safety check on all newly fetched content.
  Any scan failure → abort with `CONTENT_SCAN_FAILED` (no partial update).
- On pass: update `McpSkill` fields inside a **single DB transaction**:
  `prompt_template`, `allowed_tools`, `description`, `version`, `installed_sha256`,
  `updated_at`. Set `enabled = false` (admin must re-enable after reviewing — SEC-45).
- AuditLog `marketplace_git_update_applied` with `{ skill_id, new_version, changed_fields[] }`.
- Returns `{ skill_id, message }` on success.

#### B.4.3  UI

- "Vérifier la MàJ" button shown only on skills with `source_type = 'git'`.
- If `up_to_date`: toast *"Aucune mise à jour disponible"*.
- If update available: open a diff modal showing field-by-field changes
  (old value → new value). Read-only — editing before apply is not allowed because
  the content is hash-verified against the remote source (SEC-10/SEC-45).
  Small fields (`description`, `allowed_tools`, `version`) are shown inline from the
  `check-update` response. For `prompt_template`: if `size_bytes > 0`, a **"Voir le diff →"**
  button lazy-loads the content via `GET /preview-diff?field=prompt_template` (B.4.1) and
  renders a side-by-side diff (unified diff format, `react-diff-viewer` or equivalent).
  The button is shown even when `size_bytes` is large — no truncation. (U10)
- After apply: skill card shows `enabled: false` badge. A **"Modifier maintenant →"**
  button navigates directly to the skill's edit view, skipping manual search
  (replaces the previous 4-step flow: apply → close modal → find skill → open edit). (U3)
- If `check-update` fails (token expired, host not whitelisted, network error): show inline
  error with a contextual **"Configurer →"** link to `/admin/marketplace` (git tokens or
  whitelist section depending on `error_code`). (U7)

---

### B.5  Automatic update detection (cron)

Periodically checks whether installed Git-sourced skills have new content available.
The cron **only detects** — it never modifies skill content or re-enables skills.
All actual content changes go through the human-gated B.4.2 flow unchanged.

#### B.5.1  Infrastructure

A dedicated `cron` service in `docker-compose.yml`:

```yaml
cron:
  image: curlimages/curl:latest
  command: >-
    sh -c '
      # V14: fire immediately on first boot if no prior run recorded, then loop
      curl -sf -X POST -H "X-Cron-Secret: $${INTERNAL_CRON_SECRET}"
           http://app:3000/api/internal/run-update-checks || true;
      while true; do
        sleep $${CHECK_INTERVAL_SECONDS:-86400};
        curl -sf -X POST -H "X-Cron-Secret: $${INTERNAL_CRON_SECRET}"
             http://app:3000/api/internal/run-update-checks;
      done'
  environment:
    - INTERNAL_CRON_SECRET
    - CHECK_INTERVAL_SECONDS
  networks:
    - internal   # no internet egress — cron container only talks to app (SEC-48)
```

**First-boot behaviour (V14)**: the `|| true` ensures a container start failure
(app not yet ready) does not abort the loop. The app endpoint handles a call from a
just-started container gracefully — if the app is not ready it returns 503 and the
cron loop continues on schedule. The result: `last_scheduled_run_at` is written within
seconds of container start rather than after 24h, eliminating the false `🔴 STALE`
alarm that would otherwise persist for the full first interval on new deploys.

The `internal` Docker network has `internal: true` (blocks all internet egress from the cron
container). All external fetches are made by the `app` container, which retains internet access.

#### B.5.2  Cron endpoint

```
POST /api/internal/run-update-checks
Headers: X-Cron-Secret: <INTERNAL_CRON_SECRET>
```

- Verifies `X-Cron-Secret` against `process.env.INTERNAL_CRON_SECRET` — **constant-time compare**.
  Returns HTTP 401 on mismatch; no body revealing reason (SEC-48).
- If `INTERNAL_CRON_SECRET` is not set (env var absent) → endpoint always returns HTTP 503
  (`CRON_NOT_CONFIGURED`) — prevents accidental open endpoint on instances without cron.
- Selects at most `max_per_run` (default **50**) `McpSkill` rows where `source_type = 'git'`,
  ordered by `last_update_check_at ASC NULLS FIRST` (oldest first — SEC-50).
- For each skill:
  1. Re-fetch primary files via A.5.2 token resolution; same whitelist + `assertNotPrivateHost()` + DNS pinning as B.4.1.
  2. Compute SHA-256 of each fetched file.
  3. If all SHA-256 match `installed_sha256` → update `last_update_check_at`, move on.
  4. If any diff → write to the skill row (SEC-49):
     ```json
     {
       "changed_fields": ["prompt_template", "allowed_tools"],
       "new_sha256": { "commands/code-review.md": "def456..." },
       "detected_at": "2026-04-02T10:00:00Z"
     }
     ```
     Update `last_update_check_at`. **Never** write file content, `prompt_template`, `allowed_tools`, or `enabled`.
- Returns `{ checked: 42, updated: 3, errors: 1 }` — logged server-side only.
- AuditLog `marketplace_cron_run` with aggregate counts (no per-skill content detail).

#### B.5.3  UI integration

- Skills with non-null `pending_update` show a **"Mise à jour disponible"** badge with `detected_at`:
  *"Détectée le 2 avr. — contenu rechargé à l'ouverture"*.
- Opening the diff modal triggers a fresh `check-update` (B.4.1) server call → generates a new
  `preview_id`. If the repo reverted since the cron ran (SHA-256 now matches `installed_sha256`),
  the server clears `pending_update` and the modal shows *"Plus de mise à jour disponible"*.
- `pending_update` JSON is **never** returned in the general skills list API — only accessible
  through the dedicated `check-update` endpoint (SEC-50).

#### B.5.4  Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `INTERNAL_CRON_SECRET` | env var | — | Required; min 32 random chars. Absent = endpoint disabled. |
| `CHECK_INTERVAL_SECONDS` | env var | `86400` | Docker cron poll interval (seconds) |
| `marketplace.update_check.max_per_run` | InstanceSetting | `50` | Max skills per cron run |

#### B.5.5  Cron health monitoring & dashboard notifications

The cron endpoint writes health metadata to `InstanceSetting` after every run:

| Key | Written by | Content |
|---|---|---|
| `marketplace.cron.last_run_at` | Cron + "Lancer maintenant" | ISO datetime of last call (either source) |
| `marketplace.cron.last_run_status` | Cron + "Lancer maintenant" | `"ok"` \| `"partial_errors"` |
| `marketplace.cron.last_run_summary` | Cron + "Lancer maintenant" | `{ checked, updated, errors, triggered_by: 'cron' \| 'admin' }` JSON |
| `marketplace.cron.last_scheduled_run_at` | **Cron only** | ISO datetime of last *automated* cron call — never written by "Lancer maintenant" |

The `STALE` and `DELAYED` health states are evaluated against `last_scheduled_run_at` (not
`last_run_at`), so manual "Lancer maintenant" triggers do not mask a broken cron schedule. (L8)
`last_scheduled_run_at` is written only by requests authenticated via `X-Cron-Secret`.

**Health states** (evaluated by `GET /api/admin/marketplace/cron-health`, visible to `marketplace:admin`):

| State | Condition | Badge |
|---|---|---|
| `OK` | last_run_at within `CHECK_INTERVAL × 1.2`, 0 errors | 🟢 |
| `PARTIAL_ERRORS` | last_run_at recent but errors > 0 | 🟡 |
| `UPDATES_AVAILABLE` | N skills have non-null `pending_update` | 🟡 *N mises à jour en attente* |
| `DELAYED` | last_run_at > `CHECK_INTERVAL × 1.5` ago but < 7 days | 🟡 |
| `NOT_CONFIGURED` | `INTERNAL_CRON_SECRET` env var absent (detected at app startup) | 🔴 |
| `STALE` | last_run_at is null or > 7 days ago, and `INTERNAL_CRON_SECRET` is set | 🔴 |

Multiple states can be active simultaneously (e.g. `UPDATES_AVAILABLE` + `DELAYED`).

**Dashboard integration:**
- Admin dashboard (`/dashboard`) shows a compact `marketplace` health card when state ≠ `OK`.
- `/admin/marketplace` shows the full cron status panel with last_run_at, summary counts,
  and a "Lancer maintenant" button that calls `POST /api/internal/run-update-checks`
  directly from the admin UI (authenticated via session + `assertInstanceAdmin()`, no cron secret
  required from the UI — the API route accepts either `X-Cron-Secret` OR an authenticated admin session).
  **UI feedback after "Lancer maintenant" (U9)**: the button shows a spinner during the call.
  On success, a toast notification appears: *"Vérification terminée : {checked} skills vérifiés,
  {updated} mises à jour détectées."* The cron status badge refreshes automatically (re-fetch
  `GET /api/admin/marketplace/cron-health`). On error (e.g. 503): toast *"Échec du déclenchement
  — réessayez dans quelques instants."*
- Token expiry alerts (`expires_at` within 30 days or expired) surface in the same notification
  area as cron health — no separate notification system required.

---

## Data Model Changes Summary

### New Prisma models

```prisma
model GitUrlWhitelistEntry {
  id          String   @id @default(uuid())
  label       String
  pattern     String
  description String?
  is_builtin  Boolean  @default(false)
  enabled     Boolean  @default(true)
  created_by  String
  created_at  DateTime @default(now())
  updated_at  DateTime @updatedAt

  @@unique([pattern])
}

model MarketplaceRegistry {
  id                  String    @id @default(uuid())
  label               String
  feed_url            String
  auth_header_enc     String?   // AES-256-GCM encrypted; never returned via API
  is_builtin          Boolean   @default(false)
  enabled             Boolean   @default(true)
  last_fetched_at     DateTime?
  last_fetch_status   String?
  created_by          String
  created_at          DateTime  @default(now())
  updated_at          DateTime  @updatedAt

  @@unique([feed_url])
}
```

### `McpSkill` additions

Add columns:
```prisma
  capability_type  String?   // domain_pack | mcp_skill | harmoven_agent | js_ts_plugin
  pack_id          String?   // validated slug, unique
  author           String?
  tags             String[]  @default([])
  registry_id      String?   // FK to MarketplaceRegistry if installed from registry
  upload_sha256    String?   // SHA-256 of uploaded .hpkg content
  source_type      String?   // 'git' | 'upload' | 'registry' | 'manual'
  source_url       String?   // original Git URL used for import (git source only)
  source_ref       String?   // resolved branch/tag/commit ref at import time (git source only)
  installed_sha256     String?   // SHA-256 of primary file at last install or update (git source only)
  last_update_check_at DateTime? // last time cron checked this skill (git source only)
  pending_update       Json?     // { changed_fields, new_sha256, detected_at } — written by cron, cleared on apply
```

### New Prisma model — `GitProviderToken`

```prisma
model GitProviderToken {
  id           String    @id @default(uuid())
  label        String
  host_pattern String
  token_enc    String    // AES-256-GCM encrypted — never returned via API
  enabled      Boolean   @default(true)
  expires_at   DateTime? // optional: admin-declared expiration date; triggers dashboard warning
  created_by   String
  created_at   DateTime  @default(now())
  updated_at   DateTime  @updatedAt

  @@unique([host_pattern])
}
```

### New Prisma model — `GitHubImportPreview` (V8)

Used for opaque preview tokens in smart import (A.4.4), manual update checks (B.4.1), and
apply-update (B.4.2). **This is a new model** — it does not exist in the current schema.

```prisma
model GitHubImportPreview {
  id          String   @id @default(uuid())
  created_by  String   // userId — ownership verified in analyze-command + apply-update
  expires_at  DateTime // now() + preview_ttl_hours (default 24h)
  // Per-file SHA-256 map (supports multi-file claude_plugin imports and multi-file update diffs)
  file_hashes Json     // { "path/to/file.md": "sha256hex", ... }
  // Context tag: 'smart_import' | 'update_check' — for cleanup queries
  context     String
  created_at  DateTime @default(now())

  @@index([created_by])
  @@index([expires_at]) // enables efficient TTL cleanup job
}
```

**Cleanup**: a lightweight cleanup pass runs at the start of every cron execution (B.5.2),
deleting rows where `expires_at < NOW()`. No separate cron needed.

### `InstanceSetting` keys — no migration required (V11)

`InstanceSetting` is a typeless key-value store (`key String @unique`, `value String`).
New keys are created on first write and require **no Prisma migration**. The following keys
are created on first use (never need a migration):

- `marketplace.cron.last_run_at`
- `marketplace.cron.last_run_status`
- `marketplace.cron.last_run_summary`
- `marketplace.cron.last_scheduled_run_at`
- `marketplace.smart_import.enabled` (and all A.4.1 keys)
- `marketplace.update_check.max_per_run`

No migration file is needed for these keys.

---

## New files to create

```
lib/marketplace/
  detect-repo-type.ts       // B.2.3 static detection rules
  convert-claude-plugin.ts  // Priority 4: extract domain_packs + slash_commands; parse frontmatter allowed-tools
  analyze-slash-command.ts  // A.4: LLM-assisted pipeline template generation from slash_command body
  static-safety-scan.ts     // B.2.4 dangerous pattern matching
  malicious-packages.ts     // deny-list of known malicious npm package names (LAST_UPDATED constant, OSV+Socket sources)
  resolve-github-url.ts     // URL normalisation + GitHub API directory fetch
  upload-hpkg.ts            // B.3 zip validation + scan + persist
  assert-import-reason.ts   // assertImportReasonRequired() — server-side enforcement of require_import_reason setting (L6)

scripts/
  check-malicious-packages-freshness.ts  // build-time lint: warn if malicious-packages.ts LAST_UPDATED > 90 days (L7)

app/api/admin/marketplace/
  git-whitelist/
    route.ts                // GET + POST
    [id]/route.ts           // PATCH + DELETE
  registries/
    route.ts                // GET + POST
    [id]/route.ts           // PATCH + DELETE
    [id]/test/route.ts      // POST — test-fetch feed
  upload/
    route.ts                // POST multipart

app/(app)/marketplace/
  page.tsx                  // extend with tabs (Browse | Add from Git | Upload)
  browse-tab.tsx            // B.1
  add-from-git-tab.tsx      // B.2 (extends existing import-from-url-client.tsx)
  upload-tab.tsx            // B.3

app/(app)/admin/marketplace/
  page.tsx                  // Admin settings page (git whitelist + registries + smart import LLM + import history)
  git-whitelist-section.tsx
  registries-section.tsx
  smart-import-section.tsx
  import-history-tab.tsx

app/api/admin/marketplace/
  import-history/
    route.ts              // GET — list phantom runs (type=marketplace_import), assertInstanceAdmin()
  analyze-command/
    route.ts              // POST — LLM call + phantom run recording

app/api/admin/marketplace/skills/
  [id]/check-update/
    route.ts              // POST — B.4.1: re-fetch source, SHA-256 diff, return preview_id
  [id]/apply-update/
    route.ts              // POST — B.4.2: verify preview_id, re-scan, apply in transaction
  [id]/preview-diff/
    route.ts              // GET  — B.4.3/U10: return full content of one changed field by preview_id + field name; ownership + expiry checked; SHA-256 verified before return

app/api/admin/marketplace/git-provider-tokens/
  route.ts              // GET + POST
  [id]/route.ts         // PATCH + DELETE
  [id]/test/route.ts    // POST — test-fetch provider API root (GitHub /user, GitLab /api/v4/user…)

app/api/internal/
  run-update-checks/
    route.ts            // POST — B.5.2: X-Cron-Secret auth OR assertInstanceAdmin(); SHA-256 check, write pending_update

app/api/admin/marketplace/
  cron-health/
    route.ts            // GET — B.5.5/L14: assertInstanceAdmin(); return cron health state + last run summary
  check-pack-id/
    route.ts            // GET — U13: ?id=<slug> → { available: bool }; assertInstanceAdmin()

app/(app)/admin/marketplace/
  git-provider-tokens-section.tsx  // A.5 UI card

lib/marketplace/
  git-provider-tokens.ts  // A.5.2: token resolution (DB micromatch → env var → anonymous)
  update-checker.ts       // B.5.2: per-skill SHA-256 comparison + pending_update write
```

---

## Security requirements summary

| Control | Requirement |
|---|---|
| SEC-01 | All git/registry hostnames validated against `GitUrlWhitelistEntry` (pattern match, no DNS, micromatch) |
| SEC-02 | All external fetches: `redirect: 'error'`, timeout 10 s, streaming 1 MB/5 MB cap |
| SEC-03 | `content_sha256` verified before install; stored for traceability |
| SEC-04 | Double scan (raw + extracted fields) on all imported content |
| SEC-05 | `pack_id` validated `/^[a-z0-9_]{1,64}$/` |
| SEC-06 | Opaque error codes to client; technical details in AuditLog only |
| SEC-07 | Rate limits: 10 repo analyses/h, 5 uploads/h per userId |
| SEC-08 | All write routes: `assertInstanceAdmin()`, `enabled: false` on creation |
| SEC-09 | Inferred fields shown with `⚠ Inferred` badge |
| SEC-10 | Hash-lock: SHA-256 stored at preview, re-verified at approve |
| SEC-11 | All AuditLog writes synchronous (await, no fire-and-forget) |
| SEC-12 | ZIP bomb protection: max 10 MB uncompressed, 100 files, depth 2, extension allowlist |
| SEC-13 | Static safety patterns: shell injection, prompt injection, dependency deny-list |
| SEC-21 | Phantom runs `type=marketplace_import` excluded from all non-admin run queries — visibility gate enforced at query layer |
| SEC-22 | LLM response for smart import treated as untrusted data — output parsed with Zod, never eval'd, no DB write before admin approval |
| SEC-23 | `allowed_tools` Bash patterns from slash command frontmatter run through B.2.4 deny-list before display |
| SEC-18 | `.claude/hooks/` reject-first: only `.js`/`.ts`/`.mjs` considered (safety-checked); all other extensions (`.sh`, `.py`, `.rb`, `.go`, binaries, unknown) **always rejected** |
| SEC-24 | `runDoubleScan()` applied to every file individually fetched during Priority 4 conversion — scan failure adds file to `skipped`, never silently dropped |
| SEC-25 | Hash-lock for `claude_plugin` covers all individually fetched files, not just primary manifest — mismatch on any file aborts the entire transaction |
| SEC-26 | Registry installs without `content_sha256`: `⚠ Unverified` badge + explicit admin confirmation required — no silent unsigned install |
| SEC-27 | B.2.4 applied to `plugin.json` description/name (prompt injection) and `commands/*.md` bodies (prompt injection) and `allowed_tools` Bash patterns (shell injection) |
| SEC-28 | `allowed_tools` Bash patterns parsed with `Bash\(([^)]+)\)` before regex — prevents colon-format bypass (`Bash(cmd:sub:*)` vs space-based patterns) |
| SEC-29 | Smart import LLM: rate-limited to 20 calls/user/day; command body truncated at `max_tokens × 3`; LLM instructed to output JSON only — adversarial content in command body treated as untrusted |
| SEC-30 | `$ARGUMENTS` substitution uses named-placeholder injection — user-provided text treated as opaque data; cannot escape the prompt template delimiter |
| SEC-31 | `download_url` from registry feeds must pass `assertNotPrivateHost()` before fetch — SSRF applies to per-plugin URLs, not only feed root URL |
| SEC-32 | `analyze-command` accepts only opaque `preview_id`; SHA-256 reference read from DB, never from client body; file re-fetched server-side before LLM call |
| SEC-36 | DNS rebinding mitigation: hostname resolved once, IP pinned, same IP used for fetch — no second DNS resolution between check and connect |
| SEC-37 | `command_name` max 64 chars post-slugify; `prompt_template` max 32 768 chars; `allowed_tools` max 50 entries × 256 chars; excess rejected or truncated-and-logged before DB write |
| SEC-38 | `__system__` project created via `upsert` only — concurrent phantom run creation is idempotent, cannot produce duplicate system projects |
| SEC-33 | slash_command runtime: `prompt_template` in system-role boundary; `$ARGUMENTS` in structurally separate user-role segment — no flat string concatenation |
| SEC-34 | ZIP entries: path traversal (`..`, absolute paths, Windows paths) and symlinks rejected before any entry is read |
| SEC-35 | `.claude-plugin/plugin.json` fetched server-side after directory detection — never parsed from client input |
| SEC-19 | Claude plugin multi-pack creation runs in a single DB transaction — partial failure rolls back all |
| SEC-20 | `.claude/settings.json` MCP servers never auto-imported — admin must initiate each flow explicitly |
| SEC-14 | Registry auth tokens encrypted at rest (AES-256-GCM), never returned via API |
| SEC-15 | SSRF prevention on registry URLs: `assertNotPrivateHost()` before every fetch |
| SEC-16 | YAML parsed with `{ schema: yaml.JSON_SCHEMA }` everywhere |
| SEC-17 | `GITHUB_TOKEN` env var only, never stored in DB or returned to client |
| SEC-39 | `commands/` at root alone is insufficient Priority 4 discriminant — requires a secondary Claude signal (`CLAUDE.md`, `.claude/`, `.claude-plugin/`, or `allowed-tools` in a `commands/*.md` frontmatter) to avoid false positives on non-Claude repos |
| SEC-40 | `preview_id` ownership verified in `analyze-command`: `preview.created_by === session.userId` — mismatch → HTTP 403 `PREVIEW_NOT_OWNED`; prevents cross-admin IDOR |
| SEC-41 | `GitHubImportPreview` records expire after 24 h (configurable 1 h–7 d via `marketplace.smart_import.preview_ttl_hours`); expired `preview_id` → HTTP 410 GONE |
| SEC-42 | `slash_command` items with unresolved `mcp_dependencies` display `⚠ MCP requis` badge in Step 2 review UI — informational, does not block import, alerts admin before activation |
| SEC-43 | `tags` in `manifest.json`: max 20 entries × max 64 chars each — excess entries truncated and logged before DB write |
| SEC-44 | `apply-update` verifies `preview.created_by === session.userId` — mismatch → HTTP 403; same IDOR protection as SEC-40 |
| SEC-45 | After a git update is applied, `enabled` is reset to `false` — admin must explicitly re-enable after reviewing the updated content |
| SEC-46 | `GitProviderToken.token_enc` encrypted at rest (AES-256-GCM); never returned via API — `has_token: true/false` only; test endpoint returns rate-limit headers only, no personal data forwarded |
| SEC-47 | Token resolution is server-side only (A.5.2): DB token (most specific glob match) → env var → anonymous; client never supplies or influences token selection |
| SEC-48 | Cron endpoint `POST /api/internal/run-update-checks`: `X-Cron-Secret` verified with constant-time compare; absent `INTERNAL_CRON_SECRET` → endpoint returns HTTP 503 always; cron Docker container on isolated internal network (no internet egress) |
| SEC-49 | Cron writes only `pending_update` JSON (SHA-256 hashes + field names, no content) — never modifies `prompt_template`, `allowed_tools`, `enabled`, or any other skill content field |
| SEC-50 | Cron update checks capped at `max_per_run` (default 50) per run, ordered by `last_update_check_at ASC NULLS FIRST`; `pending_update` JSON never exposed in general skills list API |
| SEC-51 | Relevance gate runs only when Smart Import (LLM) is enabled — no static vocabulary fallback. All LLM error cases (rate limit, provider 429, timeout, Zod parse failure, context overflow, budget exceeded) surface a visible banner with "Importer sans analyse LLM" escape; gate skipped, never silently bypassed. Failed calls recorded as phantom runs with `outcome: 'error'` + `error_code`. `BUDGET_EXCEEDED` override requires `marketplace:admin` role + explicit checkbox + AuditLog `BUDGET_OVERRIDE` — not available to standard admins (L5). `require_import_reason` enforced server-side via `assertImportReasonRequired()` in both `approve` and `upload` endpoints — not client-enforced only (L6). README content never stored in DB or returned to client verbatim. NOT_RELEVANT (confidence ≥ 0.8) always requires admin free-text reason in Step 2 (cannot be disabled). Prompt injection scan on README excerpt extended to 2 000 chars to match the LLM gate input window. |
| SEC-52 | `GitProviderToken.expires_at`: optional; GET returns `expiry_status` computed server-side; token expiry warn/alert surfaced in dashboard and token list — never derived from client-supplied header |
| SEC-53 | Cron health `STALE` and `DELAYED` states evaluated against `last_scheduled_run_at` (written by `X-Cron-Secret` requests only) — not against `last_run_at` (written by both cron and "Lancer maintenant"). Manual admin triggers cannot mask a broken cron schedule. `last_run_*` InstanceSetting keys server-writable only; `last_scheduled_run_at` cron-writable only. "Lancer maintenant" requires authenticated admin session — no `X-Cron-Secret` required from UI. (L8) |
| SEC-54 | `mcp_server.command` from LLM adapter output validated against allowlist `["npx", "node", "uvx", "python", "python3", "deno", "bun"]`. Values outside the allowlist trigger `⚠ Commande inhabituelle` badge + explicit confirmation checkbox in review UI. Allowlist validated at both Zod parse time (warning flag) and admin approval time. (L9) |
| SEC-55 | `mcp_server.env` Zod constraints: max 20 entries, key ≤ 64 chars, value ≤ 512 chars. Deny-list: `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `DYLD_FORCE_FLAT_NAMESPACE`, `PATH`, `PYTHONPATH`, `NODE_PATH` → `UNSAFE_ENV_KEY` rejection → naïve import fallback. (L10) |
| SEC-56 | Monthly budget usage computed as `SUM(cost_usd)` where `created_at >= first day of current UTC month 00:00:00Z`. Calendar month boundary is UTC; no timezone ambiguity. Evaluated at query time — no scheduled reset job. (L11) |
| SEC-57 | `GitHubImportPreview.file_hashes` covers all individually fetched files (multi-file for claude_plugin and update diffs). Ownership check (`created_by === session.userId`) enforced in `analyze-command`, `apply-update`, and new `preview-diff` endpoint. Preview cleanup runs at cron start (delete where `expires_at < NOW()`). (V8) |
| SEC-58 | `GET /preview-diff` endpoint: same ownership + expiry checks as `apply-update`; returns content for one field per call; response never cached; SHA-256 of returned content verified against stored preview hash before returning to client. (U10) |
| SEC-59 | `mcp_server.args` Zod constraints: max 20 entries, each ≤ 256 chars. Deny-list of dangerous flags: `--eval`, `-e`, `--require`, `-r`, `--import`, `--inspect`, `--inspect-brk`, `--inspect-port`, `--allow-all`, `--allow-run`, `--loader`, `--experimental-loader` → `UNSAFE_ARG` rejection → naïve import fallback. (L13) |
| SEC-60 | `GET /preview-diff` rate limited to 60 requests per `preview_id` per hour (in-memory token bucket per preview_id). Prevents server-cost abuse by a legitimate but compromised admin session holding a valid preview_id. (L15) |
| SEC-61 | `GET /api/admin/marketplace/cron-health` protected by `assertInstanceAdmin()` — not publicly accessible. Returns aggregate health state only (no per-skill detail). Route listed in New files. (L14) |

### AuditLog action types introduced by marketplace v2 (V9)

`AuditLog.action` is a **free-text string column** (`String` in Prisma — no enum, no migration
required). New action types can be introduced without a schema migration.

New action types defined by marketplace v2:

| `action` value | Triggered by |
|---|---|
| `marketplace_registry_created` | POST /registries |
| `marketplace_registry_updated` | PATCH /registries/:id |
| `marketplace_registry_deleted` | DELETE /registries/:id |
| `marketplace_registry_tested` | POST /registries/:id/test |
| `marketplace_git_token_created` | POST /git-provider-tokens |
| `marketplace_git_token_updated` | PATCH /git-provider-tokens/:id |
| `marketplace_git_token_deleted` | DELETE /git-provider-tokens/:id |
| `marketplace_git_token_tested` | POST /git-provider-tokens/:id/test |
| `claude_plugin_conversion_started` | B.2.3 Priority 4 analysis |
| `claude_plugin_conversion_approved` | B.2.5 Step 3 approve |
| `marketplace_upload_approved` | POST /upload |
| `marketplace_git_update_checked` | POST /skills/:id/check-update |
| `marketplace_git_update_applied` | POST /skills/:id/apply-update |
| `marketplace_cron_run` | POST /api/internal/run-update-checks |
| `BUDGET_OVERRIDE` | analyze-command, budget exceeded + marketplace:admin override |

---

## Out of scope (v2)

- Registry signature verification (GPG) — deferred.
- User-level (non-admin) plugin installation — deferred.
- Paid/licensed plugins — deferred.
- Plugin ratings and reviews — deferred.
