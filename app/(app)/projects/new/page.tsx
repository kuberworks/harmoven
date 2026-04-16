'use client'

// app/(app)/projects/new/page.tsx
// Create project form — POST /api/projects, then redirect to the new project page.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

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

const CONFIDENTIALITY_OPTIONS = [
  { value: 'LOW',      label: 'Low — all providers eligible' },
  { value: 'MEDIUM',   label: 'Medium — trust tier 1–3' },
  { value: 'HIGH',     label: 'High — vetted providers only' },
  { value: 'CRITICAL', label: 'Critical — local models only' },
]

export default function NewProjectPage() {
  const router = useRouter()

  const [name, setName]                     = useState('')
  const [description, setDescription]       = useState('')
  const [domainProfile, setDomainProfile]   = useState('generic')
  const [confidentiality, setConfidentiality] = useState('MEDIUM')
  const [error, setError]                   = useState<string | null>(null)
  const [loading, setLoading]               = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!name.trim()) {
      setError('Project name is required.')
      return
    }

    setLoading(true)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          domain_profile: domainProfile,
          confidentiality,
        }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setError(body.error ?? `HTTP ${res.status}`)
        return
      }

      const { project } = await res.json() as { project: { id: string } }
      router.push(`/projects/${project.id}`)
    } catch {
      setError('Could not create project. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-lg mx-auto space-y-6 animate-stagger">
      {/* Back link */}
      <Link
        href="/projects"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        Projects
      </Link>

      <div>
        <h1 className="text-xl font-semibold text-foreground">New project</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          You will become the first admin of this project.
        </p>
      </div>

      <Card>
        <CardContent className="pt-5">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="name">Name <span className="text-red-400">*</span></Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My project"
                maxLength={120}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="description">Description</Label>
              <Input
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional short description"
                maxLength={500}
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
                <Label htmlFor="confidentiality">Confidentiality</Label>
                <Select value={confidentiality} onValueChange={setConfidentiality}>
                  <SelectTrigger id="confidentiality">
                    <SelectValue placeholder="Select level" />
                  </SelectTrigger>
                  <SelectContent>
                    {CONFIDENTIALITY_OPTIONS.map(({ value, label }) => (
                      <SelectItem key={value} value={value}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                {loading ? 'Creating…' : 'Create project'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
