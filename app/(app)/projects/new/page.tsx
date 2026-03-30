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

const DOMAIN_OPTIONS = [
  { value: 'generic',    label: 'Generic' },
  { value: 'legal',      label: 'Legal' },
  { value: 'medical',    label: 'Medical' },
  { value: 'finance',    label: 'Finance' },
  { value: 'software',   label: 'Software' },
  { value: 'research',   label: 'Research' },
]

const CONFIDENTIALITY_OPTIONS = [
  { value: 'LOW',    label: 'Low' },
  { value: 'MEDIUM', label: 'Medium' },
  { value: 'HIGH',   label: 'High' },
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
        <h1 className="text-[17px] font-bold text-foreground">New project</h1>
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
                <Label htmlFor="confidentiality">Confidentiality</Label>
                <select
                  id="confidentiality"
                  value={confidentiality}
                  onChange={(e) => setConfidentiality(e.target.value)}
                  className="w-full h-9 rounded-md border border-input bg-background px-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {CONFIDENTIALITY_OPTIONS.map(({ value, label }) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
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
