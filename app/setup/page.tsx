'use client'

// app/setup/page.tsx
// First-run setup wizard — 4 steps: instance config, admin account, LLM provider, verify.
// Spec: FRONTEND-SDD-PROMPT.md Priority 1, UX.md §4.1.
// Protected: only accessible if setup not yet complete (middleware checks SETUP_TOKEN or DB flag).

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, Loader2, ExternalLink, ArrowLeft, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils/cn'

// ── Types ─────────────────────────────────────────────────────────────────────

type Step = 1 | 2 | 3 | 4

interface StepState {
  // Step 1
  orgName: string
  deploymentMode: 'docker' | 'personal'
  preset: string
  // Step 2
  adminName: string
  adminEmail: string
  adminPassword: string
  // Step 3
  llmProvider: 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'other'
  // Step 4
  apiKey: string
  verified: boolean
}

// ── Step progress bar ─────────────────────────────────────────────────────────

const STEP_LABELS = ['Instance', 'Admin account', 'AI provider', 'Connect']

function StepProgress({ current }: { current: Step }) {
  return (
    <div className="mb-8 flex items-center gap-1">
      {STEP_LABELS.map((label, idx) => {
        const stepNum = (idx + 1) as Step
        const done = stepNum < current
        const active = stepNum === current
        return (
          <div key={label} className="flex flex-1 flex-col items-center gap-1">
            <div
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-colors duration-150',
                done   && 'bg-[var(--color-status-completed)] text-white',
                active && 'bg-[var(--accent-amber-9)] text-black',
                !done && !active && 'bg-surface-hover text-muted-foreground'
              )}
            >
              {done ? <CheckCircle2 className="h-4 w-4" /> : stepNum}
            </div>
            <span className={cn('text-[10px] font-medium', active ? 'text-foreground' : 'text-muted-foreground')}>
              {label}
            </span>
            {/* Connector */}
            {idx < STEP_LABELS.length - 1 && (
              <div className="absolute" style={{ display: 'none' }} />
            )}
          </div>
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

// ── Main component ────────────────────────────────────────────────────────────

export default function SetupPage() {
  const router = useRouter()
  const { toast } = useToast()

  const [step, setStep] = useState<Step>(1)
  const [isPending, startTransition] = useTransition()

  const [form, setForm] = useState<StepState>({
    orgName: '',
    deploymentMode: 'docker',
    preset: 'small_business',
    adminName: '',
    adminEmail: '',
    adminPassword: '',
    llmProvider: 'anthropic',
    apiKey: '',
    verified: false,
  })

  function update<K extends keyof StepState>(key: K, value: StepState[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  // ── Step handlers ────────────────────────────────────────────────────────

  function handleStep1(e: React.FormEvent) {
    e.preventDefault()
    if (!form.orgName.trim()) return
    setStep(2)
  }

  function handleStep2(e: React.FormEvent) {
    e.preventDefault()
    if (form.adminPassword.length < 12) {
      toast({ variant: 'destructive', title: 'Password too short', description: 'Minimum 12 characters required.' })
      return
    }
    startTransition(async () => {
      const res = await fetch('/api/setup/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_name: form.orgName,
          deployment_mode: form.deploymentMode,
          preset: form.preset,
          name: form.adminName,
          email: form.adminEmail,
          password: form.adminPassword,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        toast({ variant: 'destructive', title: 'Setup failed', description: (body as { error?: string }).error ?? 'Could not create admin account' })
        return
      }
      setStep(3)
    })
  }

  function handleStep3(e: React.FormEvent) {
    e.preventDefault()
    if (form.llmProvider === 'ollama') {
      // Ollama needs no API key — skip to confirm step
      setStep(4)
    } else {
      setStep(4)
    }
  }

  function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const res = await fetch('/api/setup/llm-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: form.llmProvider, api_key: form.apiKey }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        toast({ variant: 'destructive', title: 'Connection failed', description: (body as { error?: string }).error ?? 'Could not verify API key' })
        return
      }
      update('verified', true)
      setTimeout(() => router.push('/dashboard'), 1200)
    })
  }

  const keyLink = PROVIDER_KEY_LINK[form.llmProvider] ?? ''

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-surface-base px-4 py-12">
      {/* Background glow */}
      <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-1/3 top-1/4 h-[500px] w-[500px] rounded-full bg-[var(--accent-amber-3)] opacity-25 blur-[120px]" />
      </div>

      {/* Wordmark */}
      <div className="mb-10 text-center select-none animate-fade-in">
        <div className="text-3xl font-bold tracking-tight">
          Harmo<span className="text-[var(--accent-amber-9)]">ven</span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">AI orchestration platform</p>
      </div>

      <div className="relative z-10 w-full max-w-[480px] animate-fade-in">
        <StepProgress current={step} />

        {/* ── Step 1: Instance config ─── */}
        {step === 1 && (
          <Card>
            <CardHeader>
              <CardTitle>Welcome to Harmoven</CardTitle>
              <CardDescription>Let's get your instance ready. Takes about 5 minutes.</CardDescription>
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
                    { value: 'docker',   label: 'Docker (shared team)', sub: 'Multiple users, role-based access' },
                    { value: 'personal', label: 'Personal (single user)', sub: 'Just you, no team features' },
                  ].map(opt => (
                    <label
                      key={opt.value}
                      className={cn(
                        'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors duration-150',
                        form.deploymentMode === opt.value
                          ? 'border-[var(--accent-amber-9)] bg-[var(--accent-amber-3)]'
                          : 'border-border bg-surface-hover hover:bg-surface-selected'
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

                <p className="text-xs text-muted-foreground">
                  ℹ Presets can be changed later in Admin settings.
                </p>

                <Button type="submit" className="w-full">
                  Next <ArrowRight className="h-4 w-4" />
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {/* ── Step 2: Admin account ─── */}
        {step === 2 && (
          <Card>
            <CardHeader>
              <CardTitle>Create your admin account</CardTitle>
              <CardDescription>This account will have full instance control.</CardDescription>
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
                    required
                  />
                  <p className="text-xs text-muted-foreground">Minimum 12 characters — this protects your entire instance.</p>
                </div>
                <div className="flex gap-2 pt-2">
                  <Button type="button" variant="outline" onClick={() => setStep(1)} className="flex-1">
                    <ArrowLeft className="h-4 w-4" /> Back
                  </Button>
                  <Button type="submit" className="flex-1" disabled={isPending}>
                    {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Create account <ArrowRight className="h-4 w-4" /></>}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {/* ── Step 3: LLM provider ─── */}
        {step === 3 && (
          <Card>
            <CardHeader>
              <CardTitle>Connect an AI provider</CardTitle>
              <CardDescription>Harmoven needs at least one AI provider to run tasks.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleStep3} className="space-y-3 animate-fade-in">
                <div className="space-y-2">
                  {LLM_PROVIDERS.map(p => (
                    <label
                      key={p.value}
                      className={cn(
                        'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors duration-150',
                        form.llmProvider === p.value
                          ? 'border-[var(--accent-amber-9)] bg-[var(--accent-amber-3)]'
                          : 'border-border bg-surface-hover hover:bg-surface-selected'
                      )}
                    >
                      <input
                        type="radio"
                        name="llmProvider"
                        value={p.value}
                        checked={form.llmProvider === p.value}
                        onChange={() => update('llmProvider', p.value as StepState['llmProvider'])}
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
                <div className="flex gap-2 pt-2">
                  <Button type="button" variant="outline" onClick={() => setStep(2)} className="flex-1">
                    <ArrowLeft className="h-4 w-4" /> Back
                  </Button>
                  <Button type="submit" className="flex-1">
                    Continue <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {/* ── Step 4: API key + verify ─── */}
        {step === 4 && (
          <Card>
            <CardHeader>
              <CardTitle>
                {form.verified ? '✓ Connected!' : 'Paste your API key'}
              </CardTitle>
              <CardDescription>
                {form.verified
                  ? 'AI provider is configured. Redirecting to dashboard…'
                  : `Enter your ${LLM_PROVIDERS.find(p => p.value === form.llmProvider)?.label ?? 'provider'} API key.`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {form.verified ? (
                <div className="flex flex-col items-center gap-4 py-6 text-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-status-completed)]/20">
                    <CheckCircle2 className="h-8 w-8 text-[var(--color-status-completed)]" />
                  </div>
                  <p className="text-sm text-muted-foreground">Taking you to the dashboard…</p>
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <form onSubmit={handleVerify} className="space-y-3 animate-fade-in">
                  {form.llmProvider !== 'ollama' && (
                    <>
                      {keyLink && (
                        <a
                          href={keyLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-[var(--accent-amber-9)] hover:underline"
                        >
                          Get your key <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                      <div className="space-y-1.5">
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
                    </>
                  )}
                  {form.llmProvider === 'ollama' && (
                    <p className="text-sm text-muted-foreground">
                      Ollama runs locally — make sure it's running on <code className="font-mono text-[var(--text-code)]">localhost:11434</code>.
                    </p>
                  )}
                  <div className="flex gap-2 pt-2">
                    <Button type="button" variant="outline" onClick={() => setStep(3)} className="flex-1">
                      <ArrowLeft className="h-4 w-4" /> Back
                    </Button>
                    <Button type="submit" className="flex-1" disabled={isPending}>
                      {isPending
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : form.llmProvider === 'ollama' ? 'Verify connection' : 'Verify & finish'}
                    </Button>
                  </div>
                </form>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
