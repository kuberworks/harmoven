'use client'

// Install a pack from the official registry or a Git/local source.
// POST /api/admin/integrations  { name, source_url, source_type, version?, content? }

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Loader2 } from 'lucide-react'

type SourceType = 'official' | 'git' | 'local'

const SOURCE_TYPE_OPTIONS: { value: SourceType; label: string; placeholder: string }[] = [
  { value: 'official', label: 'Official registry', placeholder: 'e.g. invoice_followup_fr' },
  { value: 'git',      label: 'Git URL',           placeholder: 'https://github.com/…' },
  { value: 'local',    label: 'Local',             placeholder: 'Pack name (upload via CLI)' },
]

export function InstallPackClient() {
  const router         = useRouter()
  const [sourceType,   setSourceType]   = useState<SourceType>('official')
  const [name,         setName]         = useState('')
  const [sourceUrl,    setSourceUrl]    = useState('')
  const [version,      setVersion]      = useState('')
  const [loading,      setLoading]      = useState(false)
  const [error,        setError]        = useState<string | null>(null)
  const [success,      setSuccess]      = useState<string | null>(null)

  const opt = SOURCE_TYPE_OPTIONS.find((o) => o.value === sourceType)!

  async function handleInstall(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    if (!name.trim()) { setError('Pack name is required.'); return }
    if (sourceType !== 'local' && !sourceUrl.trim()) {
      setError('Source URL is required for official / Git installs.')
      return
    }

    setLoading(true)
    try {
      const body: Record<string, string> = { name: name.trim(), source_type: sourceType }
      if (sourceUrl.trim()) body.source_url = sourceUrl.trim()
      if (version.trim())   body.version    = version.trim()

      const res = await fetch('/api/admin/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
      }

      setSuccess(`Pack "${name.trim()}" installed successfully. It is pending scan approval.`)
      setName('')
      setSourceUrl('')
      setVersion('')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Install failed.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardContent className="pt-4 pb-5">
        <form onSubmit={handleInstall} className="space-y-4">
          {/* Source type picker */}
          <div className="flex gap-2">
            {SOURCE_TYPE_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => { setSourceType(o.value); setSourceUrl('') }}
                className={[
                  'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                  sourceType === o.value
                    ? 'bg-accent-amber-3 text-accent-amber-fg border border-accent-amber-8'
                    : 'bg-surface-2 text-muted-foreground border border-surface-border hover:bg-surface-3',
                ].join(' ')}
              >
                {o.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Name */}
            <div className="space-y-1">
              <label htmlFor="pack-name" className="text-xs font-medium text-muted-foreground">
                Pack name
              </label>
              <input
                id="pack-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Invoice Follow-up FR"
                className="w-full rounded-md border border-surface-border bg-surface-1 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
            </div>

            {/* Version (optional) */}
            <div className="space-y-1">
              <label htmlFor="pack-version" className="text-xs font-medium text-muted-foreground">
                Version <span className="text-muted-foreground/60">(optional)</span>
              </label>
              <input
                id="pack-version"
                type="text"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="e.g. 1.2.0"
                className="w-full rounded-md border border-surface-border bg-surface-1 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
            </div>
          </div>

          {/* Source URL */}
          {sourceType !== 'local' && (
            <div className="space-y-1">
              <label htmlFor="pack-url" className="text-xs font-medium text-muted-foreground">
                {sourceType === 'official' ? 'Pack ID / registry URL' : 'Git URL'}
              </label>
              <input
                id="pack-url"
                type="text"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder={opt.placeholder}
                className="w-full rounded-md border border-surface-border bg-surface-1 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
            </div>
          )}

          {error   && <p className="text-xs text-destructive">{error}</p>}
          {success && <p className="text-xs text-success">{success}</p>}

          <Button type="submit" disabled={loading}>
            {loading && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Install pack
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
