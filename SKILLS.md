# SKILLS.md — Harmoven Frontend Coding Patterns

> Reference for all frontend implementation work.
> Keep these patterns consistent across every file.
> Stack: Next.js 14+ App Router · shadcn/ui · Tailwind v3 · TypeScript strict · Better Auth · Zod

---

## 1. Server vs Client Component boundary

### Rule: server by default, client only when needed

```typescript
// ✅ Server Component (default — no directive needed)
// Use for: data fetching, auth checks, static layout, SSR
export default async function ProjectsPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')
  const projects = await prisma.project.findMany({ where: { /* ... */ } })
  return <ProjectsClient initialProjects={serializeProjects(projects)} />
}

// ✅ Client Component (explicit directive — needed for interactivity)
'use client'
// Use for: useState, useEffect, EventSource (SSE), useRouter, forms, dialogs
export function ProjectsClient({ initialProjects }: { initialProjects: ProjectRow[] }) { /* ... */ }
```

### Serialization rule: always convert Prisma types before crossing the boundary

```typescript
// ❌ Wrong — Decimal, Date are not serializable across server/client
return <Client cost={run.cost_actual_usd} />  // Decimal → crash

// ✅ Correct — serialize in the Server Component
const serialized = {
  cost: Number(run.cost_actual_usd),
  createdAt: run.created_at.toISOString(),
}
return <Client run={serialized} />
```

---

## 2. Better Auth — session handling

### Server Component: always use `headers()`

```typescript
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'

export default async function Page() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')
  // Access custom fields via cast (Better Auth additionalFields)
  const user = session.user as Record<string, unknown>
  const role = user.role as string | undefined
  const expertMode = user.expert_mode as boolean | undefined
}
```

### Client Component: use auth-client

```typescript
'use client'
import { authClient } from '@/lib/auth-client'

export function MyClient() {
  const { data: session, isPending } = authClient.useSession()
  if (isPending) return <Spinner />
  if (!session) return null
  const user = session.user as Record<string, unknown>
}
```

---

## 3. Permissions (RBAC)

### resolvePermissions() — always call in the Server Component

```typescript
import { resolvePermissions } from '@/lib/auth/permissions'

export default async function Page() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')
  
  const perms = await resolvePermissions(session.user.id, projectId)
  // perms is a Set<string> of permission slugs
  
  // Gate entire page
  if (!perms.has('runs:read')) redirect('/dashboard')
  
  // Pass boolean gates to client — never the full Set
  const showCosts = perms.has('runs:read_costs')
  return <RunDetailClient showCosts={showCosts} />
}
```

### PermissionGuard — client usage (already implemented)

```tsx
import { PermissionGuard } from '@/components/shared/PermissionGuard'

// Hides children if permission absent — never shows disabled button
<PermissionGuard permission="runs:create" projectId={projectId}>
  <Button>Start run</Button>
</PermissionGuard>
```

### Rule: never render a disabled action — hide it entirely

```tsx
// ❌ Wrong
<Button disabled={!canDelete}>Delete</Button>

// ✅ Correct
{canDelete && <Button onClick={handleDelete}>Delete</Button>}
```

---

## 4. SSE (Server-Sent Events) — EventSource pattern

### Full pattern with reconnect and cleanup

```typescript
'use client'
import { useEffect, useRef } from 'react'

export function useRunStream(runId: string, onEvent: (e: EventPayload) => void) {
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (!runId) return

    function connect() {
      const es = new EventSource(`/api/runs/${runId}/stream`)
      esRef.current = es

      es.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as EventPayload
          onEvent(payload)
        } catch { /* ignore malformed */ }
      }

      es.onerror = () => {
        // Reconnect only if connection dropped (not manually closed)
        if (es.readyState === EventSource.CLOSED) {
          es.close()
          setTimeout(connect, 2000) // exponential backoff optional
        }
      }
    }

    connect()

    // Cleanup: always close EventSource on unmount
    return () => {
      esRef.current?.close()
      esRef.current = null
    }
  }, [runId]) // onEvent should be stable — wrap caller in useCallback
}
```

### Project-level SSE (all runs for a project)

```typescript
// Endpoint: GET /api/projects/:id/stream
const es = new EventSource(`/api/projects/${projectId}/stream`)
// Events: run:started, run:completed, node:status, gate:pending, run:failed
```

---

## 5. Forms — shadcn/ui + Zod + React Hook Form

### Always use the full Form stack — never raw inputs

```tsx
'use client'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'

const schema = z.object({
  name: z.string().min(2).max(100),
})
type FormValues = z.infer<typeof schema>

export function MyForm({ onSuccess }: { onSuccess: () => void }) {
  const { toast } = useToast()
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '' },
  })

  async function onSubmit(values: FormValues) {
    const res = await fetch('/api/...', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    })
    if (!res.ok) {
      toast({ title: 'Error', description: await res.text(), variant: 'destructive' })
      return
    }
    toast({ title: 'Saved' })
    onSuccess()
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField control={form.control} name="name" render={({ field }) => (
          <FormItem>
            <FormLabel>Name</FormLabel>
            <FormControl><Input placeholder="My project" {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <Button type="submit" disabled={form.formState.isSubmitting}>Save</Button>
      </form>
    </Form>
  )
}
```

---

## 6. shadcn/ui — component rules

### Install missing components (never hand-roll Radix primitives)

```bash
npx shadcn@latest add select
npx shadcn@latest add dropdown-menu
npx shadcn@latest add sheet          # Slide-in drawer
npx shadcn@latest add table
npx shadcn@latest add tooltip
npx shadcn@latest add popover
npx shadcn@latest add switch
npx shadcn@latest add textarea
npx shadcn@latest add skeleton
npx shadcn@latest add alert
npx shadcn@latest add scroll-area
npx shadcn@latest add command        # Command palette base
```

### `<Toaster />` is in `app/layout.tsx` — use `useToast()` in clients

```tsx
// In client components only
import { useToast } from '@/components/ui/use-toast'
const { toast } = useToast()
toast({ title: 'Done', description: 'Your run started.' })
toast({ title: 'Error', variant: 'destructive', description: '...' })
```

### Dialog pattern — always use shadcn Dialog

```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'

<Dialog open={open} onOpenChange={setOpen}>
  <DialogContent className="sm:max-w-md">
    <DialogHeader>
      <DialogTitle>...</DialogTitle>
    </DialogHeader>
    {/* content */}
    <DialogFooter>
      <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
      <Button onClick={handleConfirm}>Confirm</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

---

## 7. theming — CSS variables (never hardcode colors)

```tsx
// ✅ Correct — CSS variable tokens
<div className="bg-surface-raised border border-surface-border text-foreground" />
<span className="text-muted-foreground" />

// Special semantic classes from globals.css
<div className="bg-status-running" />  // blue
<div className="bg-status-completed" />  // green
<div className="bg-status-failed" />  // red
<div className="bg-status-paused" />  // amber

// Dark mode: handled by CSS variables — no dark: prefix needed unless overriding
```

### Status badge helper (use until RunStatusBadge component exists)

```tsx
const STATUS_CLASS: Record<string, string> = {
  RUNNING:   'bg-blue-500/15 text-blue-400 border-blue-500/20',
  COMPLETED: 'bg-green-500/15 text-green-400 border-green-500/20',
  FAILED:    'bg-red-500/15 text-red-400 border-red-500/20',
  PAUSED:    'bg-amber-500/15 text-amber-400 border-amber-500/20',
  PENDING:   'bg-slate-500/15 text-slate-400 border-slate-500/20',
  SUSPENDED: 'bg-purple-500/15 text-purple-400 border-purple-500/20',
}
<Badge variant="outline" className={STATUS_CLASS[run.status]}>
  {run.status}
</Badge>
```

---

## 8. Motion — transitions (no decorative animations)

```tsx
// ✅ Correct — functional transitions only
<Button className="transition-all duration-150 ease-out hover:opacity-90" />

// Page load: staggered reveal via animate-stagger (defined in globals.css)
<div className="animate-stagger space-y-4">
  {items.map(item => <ItemCard key={item.id} item={item} />)}
</div>

// ❌ Never use: spring animations, bounce, infinite spin in data-heavy views
// ❌ Never: decorative animations that add no information
```

---

## 9. i18n — all user-visible strings through `lib/i18n/`

```tsx
// Server Component
import { getTranslations } from '@/lib/i18n'

export default async function Page() {
  const t = await getTranslations()
  return <h1>{t('nav.projects')}</h1>
}

// Client Component — use the hook pattern
'use client'
import { useTranslations } from '@/lib/i18n'

export function MyClient() {
  const t = useTranslations()
  return <Button>{t('common.save')}</Button>
}
```

### Rule: never hardcode English strings in JSX — use translation keys

```tsx
// ❌ Wrong
<Button>Save changes</Button>
<p>No runs yet.</p>

// ✅ Correct
<Button>{t('common.save')}</Button>
<p>{t('runs.empty_state')}</p>
```

---

## 10. Error handling — HTTP status mapping

```typescript
// In Server Components: redirect on auth/IDOR violations
if (!res.ok && res.status === 404) redirect('/projects')
if (!res.ok && res.status === 403) redirect('/dashboard')

// In Client Components: show inline error, never stack trace
if (!res.ok) {
  const msg = await res.text().catch(() => 'An error occurred')
  toast({ title: 'Error', description: msg, variant: 'destructive' })
  return
}
```

---

## 11. Hydration guard (SSR-safe state)

```typescript
// When localStorage or window access would cause hydration mismatch
'use client'
import { useState, useEffect } from 'react'

export function HydrationSafeComponent() {
  const [mounted, setMounted] = useState(false)
  const [pref, setPref] = useState<'kanban' | 'list'>('kanban')

  useEffect(() => {
    const saved = localStorage.getItem('harmoven:runs-view')
    if (saved === 'list' || saved === 'kanban') setPref(saved)
    setMounted(true)
  }, [])

  if (!mounted) return <Skeleton className="h-48" />
  return pref === 'kanban' ? <KanbanView /> : <ListView />
}
```

---

## 12. Fetch — calling API routes from Client Components

```typescript
// ✅ Always use native fetch — never axios
const res = await fetch('/api/projects', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})

// ❌ Never expose auth headers in client-rendered HTML
// Better Auth cookies handle authentication automatically for same-origin requests
```

---

## 13. TypeScript — strict mode rules

```typescript
// No `any` — use precise types from types/
import type { RunSummary } from '@/app/(app)/projects/[projectId]/runs/runs-kanban-client'
import type { DagNode } from '@/types/dag.types'

// For unknown API responses — use Zod to parse, not `as any`
const parsed = MySchema.safeParse(data)
if (!parsed.success) throw new Error('Invalid response')
const result = parsed.data

// Server-to-client serialization types
type SerializedRun = {
  id: string
  status: string
  cost: number       // was Decimal — converted with Number()
  createdAt: string  // was Date — converted with .toISOString()
}
```

---

## 14. Responsive design — breakpoints

```
Mobile:  375px  (sm: prefix)
Tablet:  768px  (md: prefix)
Desktop: 1440px (lg: prefix, max-w-5xl or max-w-7xl)

Sidebar: hidden on mobile (sheet/drawer), 260px on desktop
Content: full-width mobile, max-w-5xl centered on desktop
Tables: horizontal scroll on mobile (overflow-x-auto)
```

---

## 15. Key localStorage keys

| Key | Values | Used by |
|-----|--------|---------|
| `harmoven:runs-view` | `'kanban'` \| `'list'` | RunsViewClient |
| `harmoven-theme` | `'dark'` \| `'light'` \| `'auto'` | ThemeToggle |
| `harmoven:expert-mode` | `'true'` \| `'false'` | ExpertModeToggle |

---

## 16. Git workflow (mandatory)

```bash
# 1. Create feature branch
git checkout -b feat/my-feature

# 2. Commit with multiline message (NEVER heredoc — use file)
cat > /tmp/commit-msg.txt << 'HEREDOC'
feat(scope): short description

Body explaining what and why.

Refs: #issue
HEREDOC
git commit -F /tmp/commit-msg.txt

# 3. Merge to develop (always --no-ff)
git checkout develop
git merge --no-ff feat/my-feature -m "chore(merge): integrate feat/my-feature into develop"
```
