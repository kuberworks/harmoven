'use client'

// app/(app)/projects/[projectId]/runs/new/page.tsx
// Create a new run for the project — POST /api/runs, then redirect to the run detail page.

import { useState, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'

const DOMAIN_OPTIONS = [
  { value: 'generic',  label: 'Generic' },
  { value: 'legal',    label: 'Legal' },
  { value: 'medical',  label: 'Medical' },
  { value: 'finance',  label: 'Finance' },
  { value: 'software', label: 'Software' },
  { value: 'research', label: 'Research' },
]

interface Props {
  params: Promise<{ projectId: string }>
}

export default function NewRunPage({ params }: Props) {
  const { projectId } = use(params)
  const router = useRouter()

  const [taskInput, setTaskInput]       = useState('')
  const [domainProfile, setDomainProfile] = useState('generic')
  const [budgetUsd, setBudgetUsd]       = useState('')
  const [error, setError]               = useState<string | null>(null)
  const [loading, setLoading]           = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!taskInput.trim()) {
      setError('Task input is required.')
      return
    }

    setLoading(true)
    try {
      const body: Record<string, unknown> = {
        project_id:    projectId,
        task_input:    taskInput.trim(),
        domain_profile: domainProfile,
      }
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
        <h1 className="text-[17px] font-bold text-foreground">New run</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Describe the task and an agent will be assigned automatically.
        </p>
      </div>

      <Card>
        <CardContent className="pt-5">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="task_input">Task <span className="text-red-400">*</span></Label>
              <textarea
                id="task_input"
                value={taskInput}
                onChange={(e) => setTaskInput(e.target.value)}
                placeholder="Describe what the agent should do…"
                rows={5}
                maxLength={100_000}
                required
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="domain">Domain</Label>
                <select
                  id="domain"
                  value={domainProfile}
                  onChange={(e) => setDomainProfile(e.target.value)}
                  className="w-full h-9 rounded-md border border-input bg-background px-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {DOMAIN_OPTIONS.map(({ value, label }) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>

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
