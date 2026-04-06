// app/setup/page.tsx
// Server Component — handles the setup token auto-redirect and page layout.
// When the operator navigates to /setup without a token, this Server Component
// reads the in-process token via peekSetupToken() and does a server-side redirect
// to /setup?token=<token> automatically — no manual copy-paste required.

import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import { Loader2, Terminal } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { peekSetupToken } from '@/lib/bootstrap/setup-token'
import { SetupWizard } from './_wizard'

// ── No-token fallback (server component — no hooks) ───────────────────────────
// Shown only when the server has no active token: setup is already complete
// (middleware would redirect) or the server restarted before the token was used.

function NoTokenScreen() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Generating your setup link&hellip;</CardTitle>
        <CardDescription>
          If this screen persists, the server may have restarted before the token
          was used. Use one of the options below to retrieve the setup URL.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-foreground">Option 1 — Docker logs (default)</p>
          <div className="flex items-start gap-2 rounded-lg bg-surface-hover p-3 font-mono text-sm text-foreground">
            <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span>docker compose logs app | grep &quot;Setup URL&quot;</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Copy the full URL from the output and open it in your browser.
          </p>
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-foreground">Option 2 — Predictable token (recommended)</p>
          <div className="flex items-start gap-2 rounded-lg bg-surface-hover p-3 font-mono text-sm text-foreground">
            <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span>HARMOVEN_SETUP_TOKEN=your-secret</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Set{' '}
            <code className="font-mono text-[var(--text-code)]">HARMOVEN_SETUP_TOKEN</code>{' '}
            in your{' '}
            <code className="font-mono text-[var(--text-code)]">.env</code>{' '}
            before starting Harmoven. Then navigate to{' '}
            <code className="font-mono text-[var(--text-code)]">/setup?token=your-secret</code>.
            Min. 20 characters.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Page ────────────────────────────────────────────────────────────────
// Async Server Component — runs in Node.js, can access in-process module state.
// Auto-redirects to /setup?token=<token> when the operator navigates to /setup
// without a token in the URL.  No manual copy-paste needed.

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams

  if (!token) {
    // No token in the URL — try to read from in-process Node.js memory.
    const serverToken = peekSetupToken()
    if (serverToken) {
      // Auto-inject: server-side redirect to /setup?token=<token>.
      redirect(`/setup?token=${encodeURIComponent(serverToken)}`)
    }
    // Token unavailable (server restart after generation, or already consumed).
    // Show manual-fallback instructions.
    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center bg-surface-base px-4 py-12">
        <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
          <div className="absolute -left-1/3 top-1/4 h-[500px] w-[500px] rounded-full bg-[var(--accent-amber-3)] opacity-25 blur-[120px]" />
        </div>
        <div className="mb-10 select-none text-center animate-fade-in">
          <div className="text-3xl font-bold tracking-tight">
            Harmo<span className="text-[var(--accent-amber-9)]">ven</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">AI orchestration platform</p>
        </div>
        <div className="relative z-10 w-full max-w-[480px] animate-fade-in">
          <NoTokenScreen />
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-surface-base px-4 py-12">
      {/* Background glow */}
      <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-1/3 top-1/4 h-[500px] w-[500px] rounded-full bg-[var(--accent-amber-3)] opacity-25 blur-[120px]" />
      </div>

      {/* Wordmark */}
      <div className="mb-10 select-none text-center animate-fade-in">
        <div className="text-3xl font-bold tracking-tight">
          Harmo<span className="text-[var(--accent-amber-9)]">ven</span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">AI orchestration platform</p>
      </div>

      <div className="relative z-10 w-full max-w-[480px] animate-fade-in">
        <Suspense fallback={<div className="flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}>
          <SetupWizard />
        </Suspense>
      </div>
    </div>
  )
}
