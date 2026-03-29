# P1-FE-P1-developer.md — Harmoven Frontend v1
# Role: Developer (Frontend Phase 1 — Priority 1: Auth + Shell)
# Date: 2026-03-29
# Task: FE-P1 — Auth + Shell (Priority 1 screens)

---

## 1. Task summary

Implement the foundational frontend layer: Tailwind CSS + shadcn/ui setup, design
system tokens, auth screens (login, register), authenticated app shell (sidebar + topbar),
and the setup wizard. This unblocks all Priority 2 and 3 screens.

**Spec:** FRONTEND-SDD-PROMPT.md Priority 1, UX.md §1–4, DESIGN_SYSTEM.md, SKILLS.md

**Done when:**
- [x] Tailwind CSS v3 + PostCSS configured
- [x] Design tokens (CSS variables) from DESIGN_SYSTEM.md in globals.css
- [x] shadcn/ui primitive components (Button, Card, Input, Label, Badge, Toast, Separator)
- [x] Root app/layout.tsx: Geist fonts, Toaster
- [x] lib/auth-client.ts: Better Auth client (passkeyClient plugin)
- [x] app/(auth)/layout.tsx: centered card layout, warm amber mesh background
- [x] app/(auth)/login/page.tsx: email/password + passkey
- [x] app/(auth)/register/page.tsx: full registration form
- [x] components/shared/PermissionGuard.tsx: hide-not-disable RBAC guard
- [x] components/shared/ThemeToggle.tsx: dark/light/auto cycle
- [x] components/shared/LocaleSwitcher.tsx: en/fr switcher with PATCH /api/users/me/locale
- [x] components/shared/Sidebar.tsx: 260px fixed, collapsible to 48px, RBAC nav items
- [x] components/shared/Topbar.tsx: user menu + logout + theme/locale controls
- [x] app/(app)/layout.tsx: session check → 401 redirect + shell composition
- [x] app/(app)/dashboard/page.tsx: active runs + recent projects (Server Component)
- [x] app/setup/page.tsx: 4-step wizard (instance, admin, LLM, verify)
- [x] components/admin/UpdateBannerAsync.tsx: self-fetching wrapper for UpdateBanner

---

## 2. Files created / modified

| File | Change |
|------|--------|
| `tailwind.config.ts` | Created — design tokens, status colors, animations |
| `postcss.config.js` | Created — Tailwind + autoprefixer |
| `app/globals.css` | Created — CSS variables (dark + light modes), Tailwind directives |
| `app/layout.tsx` | Updated — Geist fonts, Toaster, globals.css import |
| `lib/auth-client.ts` | Created — Better Auth client with passkeyClient |
| `lib/utils/cn.ts` | Created — tailwind-merge + clsx utility |
| `components/ui/button.tsx` | Created — shadcn/ui Button (CVA variants) |
| `components/ui/card.tsx` | Created — Card, CardHeader, CardContent, CardFooter |
| `components/ui/input.tsx` | Created — Input field |
| `components/ui/label.tsx` | Created — Radix Label |
| `components/ui/badge.tsx` | Created — Badge with status variants |
| `components/ui/separator.tsx` | Created — Radix Separator |
| `components/ui/toast.tsx` | Created — Radix Toast primitives |
| `components/ui/use-toast.tsx` | Created — Toaster + useToast hook |
| `components/shared/PermissionGuard.tsx` | Created |
| `components/shared/ThemeToggle.tsx` | Created |
| `components/shared/LocaleSwitcher.tsx` | Created |
| `components/shared/Sidebar.tsx` | Created — collapsible, RBAC-aware nav |
| `components/shared/Topbar.tsx` | Created — user menu, logout, help |
| `components/admin/UpdateBannerAsync.tsx` | Created — self-fetching wrapper |
| `app/(auth)/layout.tsx` | Created — warm amber mesh background |
| `app/(auth)/login/page.tsx` | Created — email/password + passkey |
| `app/(auth)/register/page.tsx` | Created — registration form |
| `app/(app)/layout.tsx` | Created — session guard + shell |
| `app/(app)/dashboard/page.tsx` | Created — Server Component dashboard |
| `app/setup/page.tsx` | Created — 4-step setup wizard |

---

## 3. Technical decisions

### 3.1 Tailwind v3 (not v4)

Tailwind v4 is not yet stable enough and breaks PostCSS config.
Locked to v3.4.17 — same as DESIGN_SYSTEM.md assumption.

### 3.2 shadcn/ui: manual primitives, not CLI

`npx shadcn@latest init` would overwrite existing files; instead,
primitives are written manually following the same shadcn/ui pattern.
All downstream components (Button, Card, etc.) use the same CVA + cn() pattern.

### 3.3 Magic link deferred

`authClient.signIn.magicLink` requires the `magicLink()` plugin on the server.
The server's `lib/auth.ts` does not include this plugin (not mentioned in T1.3 spec).
Login page implements email/password + passkey only.
Magic link can be added by:
1. Adding `magicLink()` to server plugins in `lib/auth.ts`
2. Adding `magicLinkClient()` to `lib/auth-client.ts`
3. Restoring the modal in `app/(auth)/login/page.tsx`

### 3.4 twoFactorClient excluded from auth-client

`twoFactorClient()` from `better-auth/client/plugins` produces a type conflict
with the current installed version (better-auth >=1.3.26, better-call ^2.0.3).
TOTP flows (T1.3) use direct `fetch('/api/auth/two-factor/verify-totp')` instead.
Tracked as a known workaround until better-auth types are stabilized.

### 3.5 UpdateBanner: async wrapper pattern

`UpdateBanner` requires a `updateInfo` prop and is a heavyweight component.
Rather than fetching server-side (which would block layout rendering),
`UpdateBannerAsync` wraps it with client-side `useEffect` → `GET /api/updates`.
Null until update available → zero layout impact on non-admin or no-update sessions.

### 3.6 RBAC in sidebar: role string comparison

Sidebar uses `instanceRole` string ('admin' | 'instance_admin' | 'user')
passed from the Server Component layout. This matches the value stored by
better-auth's admin plugin (`user.role`). For project-level permissions,
`resolvePermissions()` is called in individual page Server Components.

### 3.7 Dashboard: Server Component with direct DB access

Dashboard uses `db.run.findMany()` and `db.project.findMany()` directly,
bypassing API routes — this is correct for Server Components (no HTTP overhead,
same Prisma client, same DB connection pool). API routes are only used by
Client Components and external consumers.

### 3.8 AuthLayout: mesh background technique

Warm amber blur blobs (`blur-[120px]`, `opacity-30`) create a subtle depth effect
on the auth screen background without SVG or image assets. This follows the
DESIGN_SYSTEM.md "Warmth Professionnel" direction.

---

## 4. Scope deferred to FE-P2

- Priority 2 screens: Projects list, Project detail, Run list (Kanban), Run detail, Human Gate
- Priority 3 screens: Settings, Admin, Analytics, Marketplace
- `app/page.tsx` root redirect (→ /dashboard if logged in, /login if not)
- TOTP 2FA screen (`/login/two-factor`)
- Magic link confirmation screen (`/login/check-email`)
- Invite acceptance (`/invite/:token`)

---

## 5. npm dependencies added

```
tailwindcss@3.4.17   postcss@8.4.49   autoprefixer@10.4.20
geist@1.3.1          next-themes@0.4.4
clsx@2.1.1           tailwind-merge@2.5.5   class-variance-authority@0.7.1
lucide-react@0.468.0
@radix-ui/react-slot@1.1.1
@radix-ui/react-label@2.1.1
@radix-ui/react-separator@1.1.0
@radix-ui/react-dialog@1.1.4
@radix-ui/react-dropdown-menu@2.1.4
@radix-ui/react-toast@1.2.4
@radix-ui/react-tabs@1.1.2
@radix-ui/react-progress@1.1.1
@radix-ui/react-avatar@1.1.2
@radix-ui/react-tooltip@1.1.6
@radix-ui/react-select@2.1.4
@radix-ui/react-switch@1.1.2
```
All installed with `--legacy-peer-deps` (better-auth peer conflict with better-call@2 vs 1.x).
