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

```bash
git checkout -b feat/<name>      # or fix/<name>
git commit -m "feat(scope): ..."
git checkout develop
git merge --no-ff feat/<name> -m "chore(merge): ..."
```

Never push to `main` directly. All merges target `develop`.

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

## Detailed patterns

See [`SKILLS.md`](SKILLS.md) for annotated code patterns (auth, RBAC, SSE, forms, toasts, dialogs, tables, confirmations, admin guards).

## Task tracking

See [`.specs/README.md`](.specs/README.md) for how specs and tasks are organized.
