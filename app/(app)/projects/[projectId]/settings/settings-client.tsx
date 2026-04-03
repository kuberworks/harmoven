'use client'

// app/(app)/projects/[projectId]/settings/settings-client.tsx
// Project config editor — name, description, domain, confidentiality, AGENTS.md override.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { useT } from '@/lib/i18n/client'
import { Loader2, Settings, Code2, ChevronDown, ChevronUp } from 'lucide-react'
import Link from 'next/link'

const DOMAIN_PROFILES = [
  { value: 'data_reporting',   label: 'Data & Reporting' },
  { value: 'app_scaffolding',  label: 'App Development' },
  { value: 'content_creation', label: 'Content Creation' },
  { value: 'legal_review',     label: 'Legal Review' },
  { value: 'marketing',        label: 'Marketing' },
  { value: 'customer_support', label: 'Customer Support' },
  { value: 'default',          label: 'General' },
]

const CONFIDENTIALITY_LEVELS = [
  { value: 'LOW',    label: 'Low — No sensitive data' },
  { value: 'MEDIUM', label: 'Medium — Internal use' },
  { value: 'HIGH',   label: 'High — Restricted data' },
]

interface ProjectConfig {
  agents_md_override?: string
  transparency_mode?: boolean
  [key: string]: unknown
}

interface Props {
  projectId: string
  name: string
  description: string | null
  domainProfile: string
  confidentiality: string
  config: ProjectConfig
  canEdit: boolean
  expertMode: boolean
}

export function ProjectSettingsClient({
  projectId, name: initialName, description: initialDescription,
  domainProfile: initialDomain, confidentiality: initialConf,
  config: initialConfig, canEdit, expertMode,
}: Props) {
  const { toast } = useToast()
  const t = useT()
  const router = useRouter()

  const [name, setName]               = useState(initialName)
  const [description, setDescription] = useState(initialDescription ?? '')
  const [domain, setDomain]           = useState(initialDomain)
  const [confidentiality, setConf]    = useState(initialConf)
  const [agentsMd, setAgentsMd]       = useState(initialConfig.agents_md_override ?? '')
  const [transparency, setTransparency] = useState(initialConfig.transparency_mode ?? false)
  const [showExpert, setShowExpert]   = useState(false)
  const [saving, setSaving]           = useState(false)

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          domain_profile: domain,
          confidentiality,
          config: {
            ...initialConfig,
            agents_md_override: agentsMd || undefined,
            transparency_mode: transparency,
          },
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast({ title: 'Project settings saved' })
      router.refresh()
    } catch {
      toast({ title: 'Failed to save settings', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={handleSave}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && e.target instanceof HTMLTextAreaElement) {
          e.preventDefault()
          e.currentTarget.requestSubmit()
        }
      }}
      className="space-y-6 animate-stagger"
    >
      {/* Core settings */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Settings className="h-4 w-4 text-muted-foreground" aria-hidden />
            Project settings
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="proj-name">Project name</Label>
              <Input
                id="proj-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My project"
                maxLength={100}
                required
                disabled={!canEdit}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="proj-conf">Confidentiality</Label>
              <Select value={confidentiality} onValueChange={setConf} disabled={!canEdit}>
                <SelectTrigger id="proj-conf">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONFIDENTIALITY_LEVELS.map((l) => (
                    <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="proj-desc">Description</Label>
            <Textarea
              id="proj-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what this project does…"
              rows={3}
              maxLength={500}
              disabled={!canEdit}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="proj-domain">Domain profile</Label>
            <Select value={domain} onValueChange={setDomain} disabled={!canEdit}>
              <SelectTrigger id="proj-domain">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DOMAIN_PROFILES.map((d) => (
                  <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Domain profiles influence how agents reason about tasks in this project.
            </p>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-surface-border px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-foreground">{t('project_settings.transparency_mode')}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Show agents' reasoning steps and intermediate outputs to all project members.
              </p>
            </div>
            <Switch
              checked={transparency}
              onCheckedChange={setTransparency}
              disabled={!canEdit}
              aria-label="Transparency mode"
            />
          </div>
        </CardContent>
      </Card>

      {/* Expert section */}
      {expertMode && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between text-base">
              <span className="flex items-center gap-2">
                <Code2 className="h-4 w-4 text-muted-foreground" aria-hidden />
                Expert overrides
                <Badge variant="secondary" className="text-xs">{t('project_settings.expert_badge')}</Badge>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setShowExpert((s) => !s)}
              >
                {showExpert ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                {showExpert ? 'Hide' : 'Show'}
              </Button>
            </CardTitle>
          </CardHeader>
          {showExpert && (
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="agents-md">AGENTS.md override</Label>
                <Textarea
                  id="agents-md"
                  value={agentsMd}
                  onChange={(e) => setAgentsMd(e.target.value)}
                  placeholder="# Project-level agent instructions&#10;&#10;Override system agent behaviour for this project only."
                  rows={10}
                  className="font-mono text-xs"
                  disabled={!canEdit}
                />
                <p className="text-xs text-muted-foreground">
                  Markdown instructions appended to AGENTS.md for all agent calls in this project.
                </p>
              </div>
            </CardContent>
          )}
        </Card>
      )}

      {/* Config history link */}
      <div className="flex items-center justify-between">
        <Link
          href={`/projects/${projectId}/settings/history`}
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-4 transition-colors"
        >
          View config history →
        </Link>

        {canEdit && (
          <Button type="submit" size="sm" disabled={saving || !name.trim()}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save changes
          </Button>
        )}
      </div>
    </form>
  )
}
