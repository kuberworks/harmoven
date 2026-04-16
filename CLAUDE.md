# CLAUDE.md — Harmoven

> Project-level context for Claude agents. Keep this file up to date when architecture conventions change.

---

## Project

Self-hosted AI agent orchestration platform. Multi-agent DAG pipelines, human-gate approvals, RBAC, real-time SSE, marketplace skill packs.

**Stack:** Next.js 15 App Router · TypeScript 5 strict · PostgreSQL 16 + Prisma · Better Auth 1.5 · Tailwind v3 + shadcn/ui · React Flow · next-intl

---

## Essential commands

```bash
npm run dev                  # dev server (needs CONFIG_GIT_DIR=/tmp/hv-cfg prefix)
npm run build                # production build
npm test                     # Jest unit tests
npm run test:e2e             # Playwright E2E
npx prisma migrate dev       # run migrations
npx prisma db seed           # seed dev data
npm run lint                 # ESLint
```

---

## Key file locations

| What | Where |
|---|---|
| DB schema | `prisma/schema.prisma` |
| Auth config | `lib/auth.ts` (server) / `lib/auth-client.ts` (client) |
| RBAC resolver | `lib/auth/permissions.ts` |
| DAG engine | `lib/execution/` |
| LLM abstraction | `lib/llm/` |
| SSE broadcaster | `lib/events/` |
| Middleware | `middleware.ts` (Edge) |
| i18n strings | `locales/en.json` + `locales/fr.json` |
| Task specs | `.specs/tasks/todo/` + `.specs/tasks/draft/` + `.specs/tasks/implemented/` |
| Coding patterns | `SKILLS.md` |
| Architecture | `.specs/analysis/architecture-review.md` |

---

## Coding conventions

### Server/Client boundary
- Pages and layouts are **Server Components by default** — no `'use client'` unless using `useState`, `useEffect`, `EventSource`, `useRouter`, or form submission
- Serialize Prisma output before crossing the boundary: `Number(decimal)`, `.toISOString()`, BigInt → string

### Auth pattern (Server Component)
```ts
import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
const session = await auth.api.getSession({ headers: await headers() })
if (!session?.user) redirect('/login')
```

### RBAC pattern (Server Component)
```ts
import { resolvePermissions } from '@/lib/auth/permissions'
const perms = await resolvePermissions(session.user.id, projectId)
if (!perms.has('runs:read')) redirect('/dashboard')
// Pass booleans to Client Components, never the full Set
const canSeeCosts = perms.has('runs:read_costs')
```

### API route pattern
```ts
// Always: validate input → check auth → check permission → business logic → return JSON (no throw)
// Also: update openapi/v1.yaml for any new or modified public endpoint or model
export async function POST(req: Request) {
  const body = await req.json()
  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // ...business logic...
  return NextResponse.json(result)
}
```

### Forms
- Always use `react-hook-form` + `zodResolver` + shadcn `<Form>` / `<FormField>`
- Never raw `<input>`

### i18n
- All visible strings via `t('key')` from `next-intl`
- Add new keys to **both** `locales/en.json` and `locales/fr.json`

---

## RBAC roles

`instance_admin` > `org_admin` > `project_manager` > `developer` > `reviewer` > `viewer` > `billing`

Key permissions: `runs:create`, `runs:read`, `runs:read_costs`, `gates:approve`, `projects:manage`, `admin:*`

`instance_admin` holds all permissions globally (no project scope check needed).

---

## Run status lifecycle

```
PENDING → RUNNING → COMPLETED
                  → FAILED
                  → SUSPENDED
RUNNING → PAUSED (human gate opens)
PAUSED  → RUNNING (gate approved) | FAILED (gate rejected)
```

---

## Git workflow

**NEVER commit directly to `develop` or `main`.** Every change goes through a branch:

```bash
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

## Hard rules (never break)

- Do NOT add/modify a public API endpoint or Prisma model exposed via API without updating `openapi/v1.yaml`
- Do NOT import `lib/auth.ts` or `lib/db/` in Client Components
- Do NOT `throw` in API routes — always `NextResponse.json({ error }, { status })`
- Do NOT modify files under `components/ui/` (shadcn generated)
- Do NOT hardcode English strings — use i18n keys
- Do NOT commit `.env` or any secret
- Do NOT add `'use client'` to pages that only fetch data
- Do NOT render disabled buttons for unauthorized actions — **hide them**

---

## Mandatory checks after every change

### After any code modification
```bash
npx tsc --noEmit   # must pass with zero errors before committing
```
Use `get_errors` tool on modified files after each edit. Fix all TypeScript errors before considering the task done. Never commit with type errors.

### After any `prisma/schema.prisma` modification
```bash
npx prisma migrate dev --name <description>   # creates and applies the migration
npx prisma generate                           # regenerates the Prisma client
```
Never leave a schema change without a corresponding migration. Always run `npx prisma generate` at minimum so the TS client is in sync with the schema.

---

## Detailed patterns

See [`SKILLS.md`](SKILLS.md) for annotated code patterns (auth, RBAC, SSE, forms, toasts, dialogs, tables, confirmations, admin guards).

## Task tracking

See [`.specs/README.md`](.specs/README.md) for how specs and tasks are organized.
