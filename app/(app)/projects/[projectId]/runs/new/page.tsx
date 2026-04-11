'use client'

// app/(app)/projects/[projectId]/runs/new/page.tsx
// Create a new run for the project — POST /api/runs, then redirect to the run detail page.

import { useState, use, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { ChevronDown, ChevronLeft } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { TaskInput } from '@/components/task/TaskInput'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

type LlmPreset = 'auto' | 'economy' | 'standard' | 'power' | 'custom'

/** Minimal shape returned by GET /api/models/available (safe; no key/config). */
interface AvailableProfile {
  id: string
  model_string: string
  tier: string
}

// Values match the DomainProfile enum in openapi/v1.yaml
const DOMAIN_OPTIONS = [
  { value: 'generic',            label: 'Generic' },
  { value: 'data_reporting',     label: 'Data & Reporting' },
  { value: 'app_scaffolding',    label: 'App Development' },
  { value: 'document_drafting',  label: 'Documents' },
  { value: 'research_synthesis', label: 'Research' },
  { value: 'marketing_content',  label: 'Marketing' },
  { value: 'hr_recruiting',      label: 'HR & Recruiting' },
  { value: 'legal_compliance',   label: 'Legal & Compliance' },
  { value: 'finance_modeling',   label: 'Finance' },
  { value: 'customer_support',   label: 'Customer Support' },
  { value: 'training_content',   label: 'Training' },
]

interface Props {
  params: Promise<{ projectId: string }>
}

export default function NewRunPage({ params }: Props) {
  const { projectId } = use(params)
  const router = useRouter()
  const searchParams = useSearchParams()

  const [taskInput, setTaskInput]               = useState('')
  const [schemaInput, setSchemaInput]           = useState('')
  const [domainProfile, setDomainProfile]       = useState('generic')
  const [outputFileFormat, setOutputFileFormat] = useState('')
  const [enableWebSearch, setEnableWebSearch]   = useState(false)
  // true once the user explicitly clicks the checkbox — prevents auto-detect from
  // overriding a deliberate user choice (either direction).
  const [webSearchUserChoice, setWebSearchUserChoice] = useState(false)
  const [budgetUsd, setBudgetUsd]               = useState('')
  const [error, setError]                 = useState<string | null>(null)
  const [loading, setLoading]             = useState(false)
  const [parentRunIds, setParentRunIds]   = useState<string[]>([])
  const [parentLabels, setParentLabels]   = useState<Record<string, string>>({})

  // LLM override section
  const [llmPreset, setLlmPreset]           = useState<LlmPreset>('auto')
  const [customOverrides, setCustomOverrides] = useState<Record<string, string>>({})
  const [availableProfiles, setAvailableProfiles] = useState<AvailableProfile[]>([])
  const [llmSectionOpen, setLlmSectionOpen] = useState(false)

  // Fetch enabled LLM profiles so preset tiers can be resolved to profile IDs.
  useEffect(() => {
    fetch('/api/models/available')
      .then(r => r.ok ? r.json() : null)
      .then((data: { profiles?: AvailableProfile[] } | null) => {
        if (data?.profiles) setAvailableProfiles(data.profiles)
      })
      .catch(() => { /* ignore — auto preset still works, custom shows empty */ })
  }, [])

  // Auto-detect real-time / news queries and suggest enabling web search.
  // Only fires while the user hasn't manually interacted with the checkbox.
  useEffect(() => {
    if (webSearchUserChoice) return
    const lower = taskInput.toLowerCase()
    const REAL_TIME_KEYWORDS = [
      // French
      'actualité', 'actualités', 'nouvelles', 'dernières nouvelles', 'dernier', 'derniers',
      'récent', 'récente', "aujourd'hui", 'ce jour', 'cette semaine', 'ce mois',
      'guerre', 'conflit', 'élection', 'événement', 'en direct',
      // English
      'latest news', 'breaking news', 'latest', 'recent', 'today', 'current events',
      'this week', 'this month', 'real-time', 'up-to-date', 'right now',
    ]
    // Also match 4-digit current years embedded in the text
    const currentYear = new Date().getFullYear()
    const hasYear = new RegExp(`\\b(${currentYear}|${currentYear - 1})\\b`).test(taskInput)
    const hasKeyword = REAL_TIME_KEYWORDS.some(kw => lower.includes(kw))
    setEnableWebSearch(hasKeyword || hasYear)
  }, [taskInput, webSearchUserChoice])

  // Parse ?from=id1,id2,... and fetch the task_input for each parent to show in the banner
  useEffect(() => {
    const from = searchParams.get('from')
    if (!from) return
    const ids = from.split(',').map(s => s.trim()).filter(Boolean).slice(0, 5)
    setParentRunIds(ids)
    // Fetch all parent run labels in parallel and apply in a single setState
    // to avoid N sequential re-renders of the form (one per resolved fetch).
    Promise.all(
      ids.map(id =>
        fetch(`/api/runs/${id}`)
          .then(r => r.ok ? r.json() : null)
          .then((data: { run?: { task_input?: string } } | null) => {
            const raw = data?.run?.task_input
            return [id, raw ? raw.slice(0, 60) + (raw.length > 60 ? '…' : '') : null] as const
          })
          .catch(() => [id, null] as const),
      ),
    ).then(entries => {
      const labels: Record<string, string> = {}
      for (const [id, label] of entries) {
        if (label !== null) labels[id] = label
      }
      setParentLabels(labels)
    })
  }, [searchParams])

  function computeLlmOverrides(): Record<string, string> | undefined {
    if (llmPreset === 'auto') return undefined
    if (llmPreset === 'custom') {
      const result: Record<string, string> = {}
      for (const agent of ['PLANNER', 'WRITER', 'REVIEWER']) {
        if (customOverrides[agent]) result[agent] = customOverrides[agent]
      }
      return Object.keys(result).length > 0 ? result : undefined
    }
    const tierMap: Record<string, string> = { economy: 'fast', standard: 'balanced', power: 'powerful' }
    const targetTier = tierMap[llmPreset]
    const profile = availableProfiles.find(p => p.tier === targetTier)
    if (!profile) return undefined
    return { PLANNER: profile.id, WRITER: profile.id, REVIEWER: profile.id }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!taskInput.trim()) {
      setError('Task input is required.')
      return
    }

    setLoading(true)
    try {
      // Read parent_run_ids directly from searchParams as a fallback — guards
      // against the edge case where the useEffect state update hasn't flushed.
      const effectiveParentIds = parentRunIds.length > 0
        ? parentRunIds
        : (() => {
            const from = searchParams.get('from')
            return from ? from.split(',').map(s => s.trim()).filter(Boolean).slice(0, 5) : []
          })()

      const taskPayload: unknown =
        schemaInput.trim()
          ? (() => {
              try { return { text: taskInput.trim(), schema: JSON.parse(schemaInput.trim()) } }
              catch { return taskInput.trim() }
            })()
          : taskInput.trim()

      const body: Record<string, unknown> = {
        project_id:    projectId,
        task_input:    taskPayload,
        domain_profile: domainProfile,
      }
      if (effectiveParentIds.length > 0) {
        body['parent_run_ids'] = effectiveParentIds
      }
      if (outputFileFormat) {
        body['output_file_format'] = outputFileFormat
      }
      if (enableWebSearch) {
        body['enable_web_search'] = true
      }
      const llmOverrides = computeLlmOverrides()
      if (llmOverrides) body['llm_overrides'] = llmOverrides
      if (budgetUsd) {
        const v = parseFloat(budgetUsd)
        if (isNaN(v) || v <= 0) {
          setError('Budget must be a positive number.')
          setLoading(false)
          return
        }
        body['budget_usd'] = v
      }

      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { error?: string }
        setError(json.error ?? `HTTP ${res.status}`)
        return
      }

      const { run } = await res.json() as { run: { id: string } }
      router.push(`/projects/${projectId}/runs/${run.id}`)
    } catch {
      setError('Could not create run. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-lg mx-auto space-y-6 animate-stagger">
      <Link
        href={`/projects/${projectId}/runs`}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        Runs
      </Link>

      <div>
        <h1 className="text-xl font-semibold text-foreground">New run</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Describe the task and an agent will be assigned automatically.
        </p>
      </div>

      {parentRunIds.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          <span className="font-medium">⛓ Chaining from {parentRunIds.length} run{parentRunIds.length > 1 ? 's' : ''}</span>
          {parentRunIds.map(id => (
            <Link
              key={id}
              href={`/projects/${projectId}/runs/${id}`}
              className="font-mono hover:underline"
            >
              {id.slice(0, 8)}{parentLabels[id] ? ` — ${parentLabels[id]}` : ''}
            </Link>
          ))}
        </div>
      )}

      <Card>
        <CardContent className="pt-5">
          <form
            onSubmit={handleSubmit}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && e.target instanceof HTMLTextAreaElement) {
                e.preventDefault()
                e.currentTarget.requestSubmit()
              }
            }}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <TaskInput
                value={taskInput}
                onChange={setTaskInput}
                schemaValue={schemaInput}
                onSchemaChange={setSchemaInput}
                domainProfile={domainProfile}
                expertMode
                maxLength={100_000}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="domain">Domain</Label>
                <Select value={domainProfile} onValueChange={setDomainProfile}>
                  <SelectTrigger id="domain">
                    <SelectValue placeholder="Select domain" />
                  </SelectTrigger>
                  <SelectContent>
                    {DOMAIN_OPTIONS.map(({ value, label }) => (
                      <SelectItem key={value} value={value}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="output_file_format">Output format (optional)</Label>
                <Select
                  value={outputFileFormat === '' ? '__auto__' : outputFileFormat}
                  onValueChange={(v) => setOutputFileFormat(v === '__auto__' ? '' : v)}
                >
                  <SelectTrigger id="output_file_format">
                    <SelectValue placeholder="Let agents decide" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__auto__">Let agents decide</SelectItem>
                    <SelectItem value="docx">📄 Document Word (.docx)</SelectItem>
                    <SelectItem value="csv">📊 CSV spreadsheet</SelectItem>
                    <SelectItem value="json">&#123;&#125; JSON data</SelectItem>
                    <SelectItem value="py">⚙️ Python script</SelectItem>
                    <SelectItem value="html">&lt;/&gt; HTML page</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">You can always download the result as Markdown.</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="budget_usd">Budget (USD, optional)</Label>
                <Input
                  id="budget_usd"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={budgetUsd}
                  onChange={(e) => setBudgetUsd(e.target.value)}
                  placeholder="e.g. 2.00"
                />
              </div>
            </div>

            <div className="flex flex-row items-start gap-3 rounded-md border border-border p-4">
              <input
                id="enable_web_search"
                type="checkbox"
                checked={enableWebSearch}
                onChange={(e) => {
                  setWebSearchUserChoice(true)
                  setEnableWebSearch(e.target.checked)
                }}
                className="mt-0.5 h-4 w-4 rounded border-border accent-amber-500 cursor-pointer"
              />
              <div className="space-y-1 leading-none">
                <Label htmlFor="enable_web_search" className="cursor-pointer">
                  🌐 Real-time web search
                </Label>
                <p className="text-xs text-muted-foreground">
                  Allows agents to search for current information on the web. May increase run duration and cost.
                </p>
                {enableWebSearch && !webSearchUserChoice && (
                  <p className="text-xs text-blue-600 dark:text-blue-400">
                    ✨ Auto-enabled — your task appears to need current information.
                  </p>
                )}
                {enableWebSearch && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    ⚠️ Search queries may expose terms from your prompt to the search API. Avoid if your request contains sensitive information.
                  </p>
                )}
              </div>
            </div>

            {/* LLM model selection */}
            <div className="rounded-md border border-border">
              <button
                type="button"
                onClick={() => setLlmSectionOpen(o => !o)}
                className="flex w-full items-center justify-between px-4 py-3 text-left"
              >
                <div className="space-y-0.5">
                  <span className="text-sm font-medium">🤖 Model selection</span>
                  <p className="text-xs text-muted-foreground">
                    {llmPreset === 'auto' ? 'Auto (system decides)' : `Preset: ${llmPreset}`}
                  </p>
                </div>
                <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', llmSectionOpen && 'rotate-180')} />
              </button>
              {llmSectionOpen && (
                <div className="border-t border-border px-4 pb-4 pt-3 space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="llm_preset">Quality preset</Label>
                    <Select value={llmPreset} onValueChange={(v) => setLlmPreset(v as LlmPreset)}>
                      <SelectTrigger id="llm_preset">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">Auto — system picks (recommended)</SelectItem>
                        <SelectItem value="economy">Economy — fastest, lowest cost</SelectItem>
                        <SelectItem value="standard">Standard — balanced quality</SelectItem>
                        <SelectItem value="power">Power — highest quality</SelectItem>
                        <SelectItem value="custom">Custom — pick per agent</SelectItem>
                      </SelectContent>
                    </Select>
                    {llmPreset !== 'auto' && llmPreset !== 'custom' && availableProfiles.find(p => p.tier === { economy: 'fast', standard: 'balanced', power: 'powerful' }[llmPreset]) && (
                      <p className="text-xs text-muted-foreground">
                        Will use: {availableProfiles.find(p => p.tier === { economy: 'fast', standard: 'balanced', power: 'powerful' }[llmPreset])!.model_string}
                      </p>
                    )}
                  </div>

                  {llmPreset === 'custom' && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {(['PLANNER', 'WRITER', 'REVIEWER'] as const).map(agent => (
                        <div key={agent} className="space-y-1.5">
                          <Label htmlFor={`llm_${agent}`}>
                            {agent.charAt(0) + agent.slice(1).toLowerCase()}
                          </Label>
                          <Select
                            value={customOverrides[agent] ?? '__auto__'}
                            onValueChange={(v) =>
                              setCustomOverrides(prev => ({ ...prev, [agent]: v === '__auto__' ? '' : v }))
                            }
                          >
                            <SelectTrigger id={`llm_${agent}`}>
                              <SelectValue placeholder="Auto" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__auto__">Auto</SelectItem>
                              {availableProfiles.map(p => (
                                <SelectItem key={p.id} value={p.id}>
                                  {p.model_string}
                                  <span className="ml-1 text-xs text-muted-foreground">({p.tier})</span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {error && (
              <p className="text-xs text-red-400 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2">
                {error}
              </p>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => router.back()}>
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={loading}
                className="bg-accent-amber text-[#111] hover:bg-accent-amber-press"
              >
                {loading ? 'Starting…' : 'Start run'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
