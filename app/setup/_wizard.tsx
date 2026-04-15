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
  adminName: string
  adminEmail: string
  adminPassword: string
  adminCreated: boolean
  llmProvider: 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'litellm'
  apiKey: string
  // User-supplied Ollama base URL — empty string means "use OLLAMA_BASE_URL env var
  // or the http://localhost:11434 fallback" (server-side resolution order).
  ollamaUrl: string
  // User-supplied base URL for OpenAI-compatible providers (LiteLLM, Together, Groq…)
  litellmUrl: string
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
  { value: 'openai',    label: 'OpenAI (ChatGPT)',   sublabel: '' },
  { value: 'gemini',    label: 'Google Gemini',      sublabel: 'Free tier available' },
  { value: 'ollama',    label: 'Ollama (local)',      sublabel: 'Free, private, runs on your machine' },
  { value: 'litellm',   label: 'Other (OpenAI-compatible)', sublabel: 'LiteLLM, Together AI, Groq, Mistral…' },
]

const PROVIDER_KEY_LINK: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai:    'https://platform.openai.com/api-keys',
  gemini:    'https://aistudio.google.com/app/apikey',
  ollama:    '',
  litellm:   '',
}

// ── Main wizard ───────────────────────────────────────────────────────────────

interface SetupWizardProps {
  /** Provider ids ('anthropic' | 'openai' | 'gemini') whose API key is already
   *  present in the server environment. The key values are never sent to the client. */
  detectedProviders: string[]
}

export function SetupWizard({ detectedProviders }: SetupWizardProps) {
  const router = useRouter()
  const { toast } = useToast()
  const searchParams = useSearchParams()
  const setupToken = searchParams.get('token') ?? ''

  const [step, setStep] = useState<Step>(1)
  const [isPending, startTransition] = useTransition()

  // ── Custom (OpenAI-compatible) provider state ──────────────────────────────
  // Phase 1: user enters base URL + key, clicks "Fetch models"
  // Phase 2: user assigns tiers to fetched models, then submits
  const [customModels, setCustomModels] = useState<
    Array<{ id: string; tier: 'fast' | 'balanced' | 'powerful' | 'skip' }> | null
  >(null)
  const [customFetching, setCustomFetching] = useState(false)
  const [customFetchError, setCustomFetchError] = useState<string | null>(null)

  // Clear the AutoRefresh retry counter — we reached the wizard, so the token
  // was found. Ensures a clean state if the user ever returns to /setup.
  useEffect(() => { sessionStorage.removeItem('hv_setup_retries') }, [])

  // Auto-select the first provider whose key is already in the environment.
  // Falls back to 'anthropic' when none are detected.
  const defaultProvider = (
    (['anthropic', 'openai', 'gemini'] as const).find(p => detectedProviders.includes(p)) ?? 'anthropic'
  )

  const [form, setForm] = useState<FormState>({
    orgName: '',
    adminName: '',
    adminEmail: '',
    adminPassword: '',
    adminCreated: false,
    llmProvider: defaultProvider,
    apiKey: '',
    ollamaUrl: '',
    litellmUrl: '',
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

    // Pre-flight validation for the custom (litellm) provider
    if (form.llmProvider === 'litellm') {
      if (!customModels) {
        toast({ variant: 'destructive', title: 'Fetch models first', description: 'Click \"Fetch available models\" to load the model list from your endpoint.' })
        return
      }
      const selected = customModels.filter(m => m.tier !== 'skip')
      const hasFast     = selected.some(m => m.tier === 'fast')
      const hasBalanced = selected.some(m => m.tier === 'balanced')
      const hasPowerful = selected.some(m => m.tier === 'powerful')
      if (!hasFast || !hasBalanced || !hasPowerful) {
        const missing = [
          !hasFast     && 'fast',
          !hasBalanced && 'balanced',
          !hasPowerful && 'powerful',
        ].filter(Boolean).join(', ')
        toast({ variant: 'destructive', title: 'Tier assignment required', description: `Assign at least one model to each tier. Missing: ${missing}.` })
        return
      }
    }

    startTransition(async () => {
      const requestBody: Record<string, unknown> = {
        provider:    form.llmProvider,
        api_key:     form.apiKey     || undefined,
        ollama_url:  form.ollamaUrl  || undefined,
        litellm_url: form.litellmUrl || undefined,
      }

      // Include tier-assigned models so the server can persist them as LlmProfile rows
      if (form.llmProvider === 'litellm' && customModels) {
        requestBody.models = customModels
          .filter(m => m.tier !== 'skip')
          .map(m => ({ id: m.id, tier: m.tier }))
      }

      const res = await fetch('/api/setup/llm-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
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

  // ── Fetch model list from a custom endpoint ────────────────────────────────
  async function handleFetchModels() {
    if (!form.litellmUrl.trim()) return
    setCustomFetching(true)
    setCustomFetchError(null)
    try {
      const res = await fetch('/api/admin/models/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_url: form.litellmUrl,
          api_key:  form.apiKey || undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setCustomFetchError((data as { error?: string }).error ?? 'Failed to fetch models')
        return
      }
      const fetched = (data as { models?: { id: string }[] }).models ?? []
      setCustomModels(fetched.map(m => ({ id: m.id, tier: 'skip' as const })))
    } catch {
      setCustomFetchError('Network error — check base URL and try again')
    } finally {
      setCustomFetching(false)
    }
  }

  function updateModelTier(id: string, tier: 'fast' | 'balanced' | 'powerful' | 'skip') {
    setCustomModels(prev => prev?.map(m => m.id === id ? { ...m, tier } : m) ?? null)
  }

  const pw          = passwordStrength(form.adminPassword)
  const keyLink     = PROVIDER_KEY_LINK[form.llmProvider] ?? ''
  const keyDetected = detectedProviders.includes(form.llmProvider)

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
                  autoComplete="email"
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
                  autoComplete="new-password"
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
                          {detectedProviders.includes(p.value) && (
                            <span className="flex items-center gap-0.5 rounded-badge bg-[var(--color-status-completed)]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-status-completed)]">
                              <CheckCircle2 className="h-2.5 w-2.5" /> Ready
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
                ) : form.llmProvider === 'litellm' ? (
                  <div className="space-y-3">
                    {/* ── Phase 1: endpoint coordinates ─────────────────── */}
                    <div className="space-y-1.5">
                      <Label htmlFor="litellm-url">Base URL</Label>
                      <Input
                        id="litellm-url"
                        type="url"
                        placeholder="http://localhost:4000/v1"
                        value={form.litellmUrl}
                        onChange={e => { update('litellmUrl', e.target.value); setCustomModels(null) }}
                        required
                        autoComplete="off"
                      />
                      <p className="text-xs text-muted-foreground">
                        OpenAI-compatible endpoint. Examples: LiteLLM proxy, Together AI, Groq, Mistral, Fireworks&hellip;
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="litellm-api-key">API key <span className="font-normal text-muted-foreground">(optional)</span></Label>
                      <Input
                        id="litellm-api-key"
                        type="password"
                        placeholder="sk-…"
                        value={form.apiKey}
                        onChange={e => update('apiKey', e.target.value)}
                        autoComplete="off"
                      />
                      <p className="text-xs text-muted-foreground">
                        Leave empty if your endpoint does not require authentication.
                      </p>
                    </div>

                    {/* Fetch button */}
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      disabled={!form.litellmUrl.trim() || customFetching}
                      onClick={handleFetchModels}
                    >
                      {customFetching
                        ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Fetching models…</>
                        : 'Fetch available models'}
                    </Button>

                    {customFetchError && (
                      <p className="text-xs text-destructive">{customFetchError}</p>
                    )}

                    {/* ── Phase 2: tier assignment ───────────────────────── */}
                    {customModels !== null && (
                      <div className="space-y-2">
                        <p className="text-sm font-medium">
                          Assign models to tiers
                          <span className="ml-1.5 font-normal text-muted-foreground">
                            ({customModels.length} available)
                          </span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Assign at least one model to each tier: <strong>fast</strong>, <strong>balanced</strong>, and <strong>powerful</strong>.
                          Models set to &ldquo;skip&rdquo; will not be used.
                        </p>
                        <div className="max-h-52 overflow-y-auto rounded-md border border-border divide-y divide-border">
                          {customModels.map(m => (
                            <div key={m.id} className="flex items-center gap-3 px-3 py-2">
                              <span
                                className="flex-1 truncate font-mono text-xs text-foreground"
                                title={m.id}
                              >
                                {m.id}
                              </span>
                              <select
                                value={m.tier}
                                onChange={e => updateModelTier(m.id, e.target.value as typeof m.tier)}
                                className="shrink-0 rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                              >
                                <option value="skip">— skip —</option>
                                <option value="fast">fast</option>
                                <option value="balanced">balanced</option>
                                <option value="powerful">powerful</option>
                              </select>
                            </div>
                          ))}
                        </div>
                        {(() => {
                          const sel      = customModels.filter(m => m.tier !== 'skip')
                          const hasFast     = sel.some(m => m.tier === 'fast')
                          const hasBalanced = sel.some(m => m.tier === 'balanced')
                          const hasPowerful = sel.some(m => m.tier === 'powerful')
                          if (hasFast && hasBalanced && hasPowerful) {
                            return (
                              <p className="flex items-center gap-1 text-xs text-[var(--color-status-completed)]">
                                <CheckCircle2 className="h-3.5 w-3.5" /> All tiers assigned
                              </p>
                            )
                          }
                          const missing = [
                            !hasFast     && 'fast',
                            !hasBalanced && 'balanced',
                            !hasPowerful && 'powerful',
                          ].filter(Boolean).join(', ')
                          return (
                            <p className="text-xs text-muted-foreground">
                              Still needed: <strong>{missing}</strong>
                            </p>
                          )
                        })()}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {keyDetected && (
                      <div className="flex items-start gap-2 rounded-lg border border-[var(--color-status-completed)] bg-[var(--color-status-completed)]/10 px-3 py-2">
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-status-completed)]" />
                        <p className="text-xs text-[var(--color-status-completed)]">
                          <span className="font-semibold">API key already configured.</span>{' '}
                          Leave the field below empty to use it, or enter a different key to override.
                        </p>
                      </div>
                    )}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="api-key">
                          API key{' '}
                          {keyDetected && (
                            <span className="font-normal text-muted-foreground">(optional)</span>
                          )}
                        </Label>
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
                      </div>
                      <Input
                        id="api-key"
                        type="password"
                        placeholder={keyDetected ? 'Leave empty to use the pre-configured key' : 'sk-ant-…'}
                        value={form.apiKey}
                        onChange={e => update('apiKey', e.target.value)}
                        required={!keyDetected}
                        autoComplete="off"
                      />
                    </div>
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
    const stored = sessionStorage.getItem(RETRY_KEY)
    // 'exhausted' sentinel means we already tried MAX_RETRIES times and the
    // token was never available. Show the fallback immediately without retrying.
    setRetries(stored === 'exhausted' ? MAX_RETRIES : parseInt(stored ?? '0', 10))
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted) return
    if (retries >= MAX_RETRIES) {
      // Mark as exhausted — do NOT removeItem here.
      // Removing the key would allow a manual page refresh to restart the loop.
      // The key is cleared only by SetupWizard (token successfully received).
      sessionStorage.setItem(RETRY_KEY, 'exhausted')
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
