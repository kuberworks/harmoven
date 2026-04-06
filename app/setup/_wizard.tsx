'use client'

// app/setup/_wizard.tsx
// Client Component — all interactive wizard logic.
// Rendered by the Server Component (page.tsx) only when a valid token is in the URL.
// The Server Component guarantees the token is present before rendering this component,
// so the `if (!setupToken)` guard is intentionally omitted here.

import { useState, useTransition, Fragment, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { authClient } from '@/lib/auth-client'
import { CheckCircle2, Loader2, ExternalLink, ArrowLeft, ArrowRight, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils/cn'

// ── Types ─────────────────────────────────────────────────────────────────────

type Step = 1 | 2 | 3

interface FormState {
  orgName: string
  deploymentMode: 'docker' | 'personal'
  adminName: string
  adminEmail: string
  adminPassword: string
  adminCreated: boolean
  llmProvider: 'anthropic' | 'openai' | 'gemini' | 'ollama'
  apiKey: string
  // User-supplied Ollama base URL — empty string means "use OLLAMA_BASE_URL env var
  // or the http://localhost:11434 fallback" (server-side resolution order).
  ollamaUrl: string
  verified: boolean
}

// ── Password strength ──────────────────────────────────────────────────────────

function passwordStrength(pw: string): { bars: number; label: string } {
  if (!pw) return { bars: 0, label: '' }
  const score = [
    pw.length >= 12,
    pw.length >= 16,
    /[A-Z]/.test(pw) && /[a-z]/.test(pw),
    /[0-9]/.test(pw),
    /[^A-Za-z0-9]/.test(pw),
  ].filter(Boolean).length
  const bars = score <= 1 ? 1 : score <= 2 ? 2 : score <= 3 ? 3 : 4
  const labels = ['', 'Weak', 'Fair', 'Good', 'Strong'] as const
  return { bars, label: labels[bars as 0 | 1 | 2 | 3 | 4] }
}

function strengthBarColor(bars: number): string {
  if (bars === 1) return 'bg-red-500'
  if (bars === 2) return 'bg-orange-400'
  if (bars === 3) return 'bg-yellow-400'
  return 'bg-green-500'
}

// ── Step progress bar ──────────────────────────────────────────────────────────

const STEP_LABELS = ['Instance', 'Admin account', 'AI provider']

function StepProgress({ current }: { current: Step }) {
  return (
    <div className="mb-8 flex w-full items-start">
      {STEP_LABELS.map((label, idx) => {
        const stepNum = (idx + 1) as Step
        const done   = stepNum < current
        const active = stepNum === current
        return (
          <Fragment key={label}>
            {/* Connector — rendered before each step except the first */}
            {idx > 0 && (
              <div
                className={cn(
                  'mt-3.5 h-px flex-1 transition-colors duration-300',
                  idx < current ? 'bg-[var(--color-status-completed)]' : 'bg-border',
                )}
              />
            )}
            <div className="flex flex-col items-center gap-1 px-2">
              <div
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-colors duration-150',
                  done   && 'bg-[var(--color-status-completed)] text-white',
                  active && 'bg-[var(--accent-amber-9)] text-black',
                  !done && !active && 'bg-surface-hover text-muted-foreground',
                )}
              >
                {done ? <CheckCircle2 className="h-4 w-4" /> : stepNum}
              </div>
              <span className={cn('text-[10px] font-medium whitespace-nowrap', active ? 'text-foreground' : 'text-muted-foreground')}>
                {label}
              </span>
            </div>
          </Fragment>
        )
      })}
    </div>
  )
}

// ── Provider options ──────────────────────────────────────────────────────────

const LLM_PROVIDERS: readonly { value: string; label: string; sublabel: string; recommended?: boolean }[] = [
  { value: 'anthropic', label: 'Anthropic (Claude)', sublabel: 'Recommended — best for most tasks', recommended: true },
  { value: 'openai',    label: 'OpenAI (GPT)',       sublabel: '' },
  { value: 'gemini',    label: 'Google Gemini',      sublabel: 'Free tier available' },
  { value: 'ollama',    label: 'Ollama (local)',      sublabel: 'Free, private, runs on your machine' },
]

const PROVIDER_KEY_LINK: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai:    'https://platform.openai.com/api-keys',
  gemini:    'https://aistudio.google.com/app/apikey',
  ollama:    '',
}

// ── Main wizard ───────────────────────────────────────────────────────────────

export function SetupWizard() {
  const router = useRouter()
  const { toast } = useToast()
  const searchParams = useSearchParams()
  const setupToken = searchParams.get('token') ?? ''

  const [step, setStep] = useState<Step>(1)
  const [isPending, startTransition] = useTransition()

  // Clear the AutoRefresh retry counter — we reached the wizard, so the token
  // was found. Ensures a clean state if the user ever returns to /setup.
  useEffect(() => { sessionStorage.removeItem('hv_setup_retries') }, [])

  const [form, setForm] = useState<FormState>({
    orgName: '',
    deploymentMode: 'docker',
    adminName: '',
    adminEmail: '',
    adminPassword: '',
    adminCreated: false,
    llmProvider: 'anthropic',
    apiKey: '',
    ollamaUrl: '',
    verified: false,
  })

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  // ── Step handlers ─────────────────────────────────────────────────────────

  function handleStep1(e: React.FormEvent) {
    e.preventDefault()
    if (!form.orgName.trim()) return
    setStep(2)
  }

  function handleStep2(e: React.FormEvent) {
    e.preventDefault()
    // If admin was already created (e.g. Back was pressed then Next again), skip to step 3.
    if (form.adminCreated) { setStep(3); return }
    if (form.adminPassword.length < 12) {
      toast({ variant: 'destructive', title: 'Password too short', description: 'Minimum 12 characters required.' })
      return
    }
    startTransition(async () => {
      const res = await fetch('/api/setup/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          setup_token:     setupToken,
          org_name:        form.orgName,
          deployment_mode: form.deploymentMode,
          preset:          'small_business',
          name:            form.adminName,
          email:           form.adminEmail,
          password:        form.adminPassword,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        toast({ variant: 'destructive', title: 'Setup failed', description: (body as { error?: string }).error ?? 'Could not create admin account' })
        return
      }
      // Establish a session immediately — llm-verify requires instance_admin because userCount > 0 after this point.
      const signIn = await authClient.signIn.email({ email: form.adminEmail, password: form.adminPassword })
      if (signIn.error) {
        console.warn('[setup] Auto sign-in after admin creation failed:', signIn.error)
        toast({ variant: 'default', title: 'Account created', description: 'Sign-in failed — LLM verification may require re-login if it fails.' })
      }
      update('adminCreated', true)
      setStep(3)
    })
  }

  function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const res = await fetch('/api/setup/llm-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider:   form.llmProvider,
          api_key:    form.apiKey    || undefined,
          ollama_url: form.ollamaUrl || undefined,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        toast({ variant: 'destructive', title: 'Connection failed', description: (body as { error?: string }).error ?? 'Could not verify provider' })
        return
      }
      update('verified', true)
      router.push('/dashboard')
    })
  }

  const pw      = passwordStrength(form.adminPassword)
  const keyLink = PROVIDER_KEY_LINK[form.llmProvider] ?? ''

  return (
    <>
      <StepProgress current={step} />

      {/* ── Step 1: Instance config ────────────────────────────── */}
      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Welcome to Harmoven</CardTitle>
            <CardDescription>Configure your instance. Takes about 5 minutes.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleStep1} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="org-name">Organization name</Label>
                <Input
                  id="org-name"
                  placeholder="Acme Corp"
                  value={form.orgName}
                  onChange={e => update('orgName', e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label>Deployment mode</Label>
                {[
                  { value: 'docker',   label: 'Shared team',  sub: 'Multiple users with role-based access control' },
                  { value: 'personal', label: 'Personal use', sub: 'Single user — team and RBAC features disabled' },
                ].map(opt => (
                  <label
                    key={opt.value}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors duration-150',
                      form.deploymentMode === opt.value
                        ? 'border-[var(--accent-amber-9)] bg-[var(--accent-amber-3)]'
                        : 'border-border bg-surface-hover hover:bg-surface-selected',
                    )}
                  >
                    <input
                      type="radio"
                      name="deploymentMode"
                      value={opt.value}
                      checked={form.deploymentMode === opt.value}
                      onChange={() => update('deploymentMode', opt.value as 'docker' | 'personal')}
                      className="mt-0.5 accent-[var(--accent-amber-9)]"
                    />
                    <div>
                      <div className="text-sm font-medium text-foreground">{opt.label}</div>
                      <div className="text-xs text-muted-foreground">{opt.sub}</div>
                    </div>
                  </label>
                ))}
              </div>

              <Button type="submit" className="w-full">
                Next <ArrowRight className="h-4 w-4" />
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* ── Step 2: Admin account ──────────────────────────────── */}
      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle>Create your admin account</CardTitle>
            <CardDescription>This account has full instance control.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleStep2} className="space-y-3 animate-fade-in">
              <div className="space-y-1.5">
                <Label htmlFor="admin-name">Full name</Label>
                <Input
                  id="admin-name"
                  placeholder="Marie Dupont"
                  value={form.adminName}
                  onChange={e => update('adminName', e.target.value)}
                  disabled={form.adminCreated}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="admin-email">Email</Label>
                <Input
                  id="admin-email"
                  type="email"
                  placeholder="marie@acme.com"
                  value={form.adminEmail}
                  onChange={e => update('adminEmail', e.target.value)}
                  disabled={form.adminCreated}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="admin-password">Password</Label>
                <Input
                  id="admin-password"
                  type="password"
                  placeholder="Min. 12 characters"
                  minLength={12}
                  value={form.adminPassword}
                  onChange={e => update('adminPassword', e.target.value)}
                  disabled={form.adminCreated}
                  required
                />
                {form.adminCreated ? (
                  <p className="flex items-center gap-1 text-xs text-[var(--color-status-completed)]">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Account created
                  </p>
                ) : pw.bars > 0 && (
                  <div className="space-y-1">
                    <div className="flex gap-0.5">
                      {[1, 2, 3, 4].map(i => (
                        <div
                          key={i}
                          className={cn(
                            'h-1 flex-1 rounded-full transition-colors duration-200',
                            i <= pw.bars ? strengthBarColor(pw.bars) : 'bg-border',
                          )}
                        />
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">{pw.label}</p>
                  </div>
                )}
              </div>
              <div className="flex gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setStep(1)}
                  className="flex-1"
                  disabled={form.adminCreated || isPending}
                >
                  <ArrowLeft className="h-4 w-4" /> Back
                </Button>
                <Button type="submit" className="flex-1" disabled={isPending}>
                  {isPending
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : form.adminCreated
                      ? <>Next <ArrowRight className="h-4 w-4" /></>
                      : <>Create account <ArrowRight className="h-4 w-4" /></>}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* ── Step 3: AI provider + verify ──────────────────────── */}
      {step === 3 && (
        <Card>
          <CardHeader>
            <CardTitle>
              {form.verified
                ? <span className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-[var(--color-status-completed)]" /> Connected!</span>
                : 'Connect an AI provider'}
            </CardTitle>
            <CardDescription>
              {form.verified
                ? 'Redirecting to your dashboard…'
                : 'Harmoven needs at least one AI provider to orchestrate tasks.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {form.verified ? (
              <div className="flex justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <form onSubmit={handleVerify} className="space-y-4 animate-fade-in">
                <div className="space-y-2">
                  {LLM_PROVIDERS.map(p => (
                    <label
                      key={p.value}
                      className={cn(
                        'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors duration-150',
                        form.llmProvider === p.value
                          ? 'border-[var(--accent-amber-9)] bg-[var(--accent-amber-3)]'
                          : 'border-border bg-surface-hover hover:bg-surface-selected',
                      )}
                    >
                      <input
                        type="radio"
                        name="llmProvider"
                        value={p.value}
                        checked={form.llmProvider === p.value}
                        onChange={() => update('llmProvider', p.value as FormState['llmProvider'])}
                        className="mt-0.5 accent-[var(--accent-amber-9)]"
                      />
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground">{p.label}</span>
                          {p.recommended && (
                            <span className="rounded-badge bg-[var(--accent-amber-3)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--accent-amber-9)]">
                              Recommended
                            </span>
                          )}
                        </div>
                        {p.sublabel && <div className="text-xs text-muted-foreground">{p.sublabel}</div>}
                      </div>
                    </label>
                  ))}
                </div>

                {form.llmProvider === 'ollama' ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="ollama-url">Ollama base URL</Label>
                    <Input
                      id="ollama-url"
                      type="url"
                      placeholder="http://192.168.1.50:11434"
                      value={form.ollamaUrl}
                      onChange={e => update('ollamaUrl', e.target.value)}
                      autoComplete="off"
                    />
                    <p className="text-xs text-muted-foreground">
                      Leave empty to use{' '}
                      <code className="font-mono text-[var(--text-code)]">OLLAMA_BASE_URL</code>{' '}
                      env var, or{' '}
                      <code className="font-mono text-[var(--text-code)]">http://localhost:11434</code>{' '}
                      if Ollama runs on the same host as Harmoven.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {keyLink && (
                      <a
                        href={keyLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-[var(--accent-amber-9)] hover:underline"
                      >
                        Get your API key <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                    <Label htmlFor="api-key">API key</Label>
                    <Input
                      id="api-key"
                      type="password"
                      placeholder="sk-ant-…"
                      value={form.apiKey}
                      onChange={e => update('apiKey', e.target.value)}
                      required
                      autoComplete="off"
                    />
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <Button type="button" variant="outline" onClick={() => setStep(2)} className="flex-1">
                    <ArrowLeft className="h-4 w-4" /> Back
                  </Button>
                  <Button type="submit" className="flex-1" disabled={isPending}>
                    {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify & finish'}
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      )}
    </>
  )
}

// ── Auto-refresh helper ───────────────────────────────────────────────────────
// Retries the page load every 1.5 s so the Server Component re-runs and
// peekSetupToken() is re-evaluated once instrumentation.ts has finished.
//
// WHY window.location.reload() instead of router.refresh():
//   router.refresh() unmounts + remounts this component on each call, resetting
//   useState(0) back to 0 — the MAX_RETRIES guard never fires → infinite loop.
//   A full page reload preserves sessionStorage, so the retry count survives
//   across reloads and the cap actually works.
//
// WHY NOT router.refresh() for the redirect:
//   redirect() in a Server Component during router.refresh() is not guaranteed
//   to trigger a client navigation. A full reload lets the browser follow the
//   HTTP redirect natively.

const MAX_RETRIES = 5
const RETRY_KEY   = 'hv_setup_retries'

export function AutoRefresh() {
  // Always initialise to 0 so SSR and the first client render produce identical
  // HTML (return null). sessionStorage is read in useEffect (client-only) and
  // triggers a state update only after hydration is complete.
  const [retries, setRetries] = useState(0)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const stored = parseInt(sessionStorage.getItem(RETRY_KEY) ?? '0', 10)
    setRetries(stored)
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted) return
    if (retries >= MAX_RETRIES) {
      sessionStorage.removeItem(RETRY_KEY)
      return
    }
    const t = setTimeout(() => {
      sessionStorage.setItem(RETRY_KEY, String(retries + 1))
      window.location.reload()
    }, 1500)
    return () => clearTimeout(t)
  }, [mounted, retries])

  // Before hydration or while retrying: render nothing (matches SSR output).
  if (!mounted || retries < MAX_RETRIES) return null

  // Server didn't produce a token after 7.5 s — something is wrong.
  // Fall back to manual instructions.
  return (
    <div className="space-y-4 pt-2">
      <p className="text-xs text-muted-foreground">
        The server took too long to generate the setup token. Use one of the
        options below to complete setup.
      </p>
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-foreground">Option 1 — Docker logs</p>
        <div className="flex items-start gap-2 rounded-lg bg-surface-hover p-3 font-mono text-sm text-foreground">
          <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span>docker compose logs app | grep &quot;Setup URL&quot;</span>
        </div>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-foreground">Option 2 — Predictable token</p>
        <div className="flex items-start gap-2 rounded-lg bg-surface-hover p-3 font-mono text-sm text-foreground">
          <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span>HARMOVEN_SETUP_TOKEN=your-secret</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Set in <code className="font-mono text-[var(--text-code)]">.env</code> before
          starting Harmoven (min. 20 chars), then open{' '}
          <code className="font-mono text-[var(--text-code)]">/setup?token=your-secret</code>.
        </p>
      </div>
    </div>
  )
}
