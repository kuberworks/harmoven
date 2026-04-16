# Harmoven — Copilot Instructions

Self-hosted AI agent orchestration platform. Multi-agent DAG pipelines, human-gate approvals, RBAC, real-time SSE, marketplace skill packs. Deploy via Docker Compose or Electron.

---

## Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 App Router (Server Components by default) |
| Language | TypeScript 5 strict mode |
| Database | PostgreSQL 16 via Prisma ORM |
| Auth | Better Auth 1.5 — TOTP + Passkey MFA |
| UI | Tailwind CSS v3, Radix UI (shadcn/ui), Lucide icons |
| Forms | React Hook Form + Zod |
| Pipeline editor | React Flow (`@xyflow/react`) |
| LLM providers | Anthropic, OpenAI, Gemini, LiteLLM, CometAPI |
| MCP | Model Context Protocol SDK 1.28 |
| i18n | `next-intl`, locale files in `locales/en.json` + `locales/fr.json` |

---

## Folder structure

```
app/
  (auth)/           login, register
  (app)/            all authenticated pages
    dashboard/
    projects/[projectId]/runs/[runId]/gate/
    admin/          instance-admin only
    marketplace/
    analytics/
    settings/
  api/              API routes (never import server libs from client components)
  setup/            first-run wizard
components/
  ui/               shadcn primitives (never modify generated files)
  shared/           cross-feature components (PermissionGuard, etc.)
  pipeline/         React Flow DAG editor
  run/ gate/ project/ admin/
lib/
  auth.ts           server-side auth (Better Auth)
  auth-client.ts    client-side authClient
  auth/             permissions resolver
  execution/        DAG engine (custom + Temporal + Restate)
  agents/           classifier, planner, writer, reviewer, handoff
  llm/              provider abstraction + selector
  marketplace/      registry feeds, git tokens, pkg validator, update checker
  db/               Prisma client singleton
  mcp/              MCP skill client
  i18n/             i18n helpers
  security/         SSRF guard, CSP utils
  events/           SSE broadcaster
prisma/
  schema.prisma     canonical schema — source of truth
  better-auth.prisma
.specs/             task specs and agent logs (see .specs/README.md)
```

---

## Key coding rules

### Components
- **Server Component by default** — no `'use client'` unless you need `useState`, `useEffect`, `EventSource`, `useRouter`, or form submission
- **Serialization** — always convert Prisma `Decimal`/`Date`/`BigInt` to primitive before passing to a Client Component (`Number(x)`, `.toISOString()`)
- **Never render a disabled action** — hide it entirely with `canDo && <Button ...>`

### Auth (server)
```ts
import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
const session = await auth.api.getSession({ headers: await headers() })
if (!session?.user) redirect('/login')
```

### Auth (client)
```ts
import { authClient } from '@/lib/auth-client'
const { data: session } = authClient.useSession()
```

### RBAC / Permissions
```ts
import { resolvePermissions } from '@/lib/auth/permissions'
const perms = await resolvePermissions(session.user.id, projectId)
if (!perms.has('runs:read')) redirect('/dashboard')
```
- `instance_admin` holds all permissions globally
- Always call `resolvePermissions` in the Server Component; pass booleans to the Client Component

### SSE streaming
```ts
// Client hook — see hooks/useRunStream.ts or SKILLS.md §4
const es = new EventSource(`/api/runs/${runId}/stream`)
// Always close in useEffect cleanup
```

### Forms
- Always use `react-hook-form` + `zodResolver` + shadcn `<Form>`
- Never use raw `<input>` outside shadcn `<FormField>`

### API routes
- Input validation via Zod at every route boundary
- Return `NextResponse.json({ error }, { status })` — no raw `throw`
- Auth check first, permission check second, then business logic
- **Any new or modified public API endpoint → update `openapi/v1.yaml`**
- **Any new Prisma model or field exposed via API → update `openapi/v1.yaml`**

### i18n
- All user-visible strings via `t('key')` — never hardcode English text in components
- Add new keys to both `locales/en.json` and `locales/fr.json`

---

## RBAC roles & key permissions

| Role | Scope |
|---|---|
| `instance_admin` | full access (all permissions globally) |
| `org_admin` | manage org members and projects |
| `project_manager` | manage one project |
| `developer` | create/start runs |
| `reviewer` | approve/reject gates |
| `viewer` | read-only |
| `billing` | see costs only |

Key permissions: `runs:create`, `runs:read`, `runs:read_costs`, `gates:approve`, `projects:manage`, `admin:*`

---

## Run lifecycle

`PENDING` → `RUNNING` → `COMPLETED | FAILED | SUSPENDED`
`RUNNING` → `PAUSED` (human gate) → `RUNNING` (gate approved) | `FAILED` (gate rejected)

---

## Git workflow

**NEVER commit directly to `develop` or `main`.** Every change goes through a branch:

```
git checkout -b feat/<name>   # or fix/<name> / chore/<name> / docs/<name>
# make changes + commits on the branch
git checkout develop
git merge --no-ff feat/<name> -m "chore(merge): feat/<name> into develop"
```

- `develop` is the integration branch — only receives merges, never direct commits
- `main` is the release branch — only receives merges from `develop`, never direct commits
- Branch naming: `feat/`, `fix/`, `chore/`, `docs/`

### Commit message format

Every commit message **must** have:
- A concise subject line: `type(scope): short description` (≤72 chars)
- A **body** listing every file changed and what was done — one bullet per logical change

Example:
```
feat(marketplace): add edit dialog for integration name and config

- app/(app)/admin/integrations/skill-actions-client.tsx: add Edit dialog
  with name field + JSON config textarea, PATCH /api/admin/integrations/:id
- app/api/admin/integrations/[id]/route.ts: extend PATCH body schema to
  accept optional `name` (z.string().min(1).max(128))
- locales/en.json + fr.json: add integration.edit.* i18n keys
- openapi/v1.yaml: document name field in PATCH /admin/integrations/{id}
```

The body is **mandatory** — a subject-only commit is not acceptable.

---

## What to avoid

- Do NOT add or change a public API route/model without updating `openapi/v1.yaml`
- Do NOT import `lib/auth.ts` or Prisma directly in Client Components
- Do NOT use `db.user.count()` on dashboards without explicit admin gate
- Do NOT `throw` in API routes — return error JSON
- Do NOT modify files in `components/ui/` (shadcn generated)
- Do NOT hardcode English strings — use i18n keys
- Do NOT commit `.env` or secrets
- Do NOT add `'use client'` to pages that only do data fetching

---

## Mandatory checks after every change

### After any code modification
```bash
npx tsc --noEmit   # must pass with zero errors before committing
```
Use `get_errors` tool on modified files, or run `npx tsc --noEmit` in terminal. Fix all TypeScript errors before considering the task done.

### After any `prisma/schema.prisma` modification
```bash
npx prisma migrate dev --name <description>   # creates and applies the migration
npx prisma generate                           # regenerates the Prisma client
```
Never leave a schema change without a corresponding migration. If running in a context where the DB is not available, at minimum run `npx prisma generate` and note that a migration is required.

---

## Detailed patterns

See [`SKILLS.md`](../SKILLS.md) for full annotated code patterns (auth, RBAC, SSE, forms, toasts, dialogs, tables, confirmations).
