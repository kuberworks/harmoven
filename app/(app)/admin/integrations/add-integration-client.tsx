'use client'

// Add integration button + dialog.
// POST /api/admin/integrations { name, source_type, source_url?, version? }

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type SourceType = 'official' | 'git' | 'local'

const defaultForm = {
  name: '',
  source_type: 'git' as SourceType,
  source_url: '',
  version: '',
}

export function AddIntegrationClient() {
  const [open, setOpen]       = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [form, setForm]       = useState(defaultForm)
  const router = useRouter()

  function reset() { setForm(defaultForm); setError(null) }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const body: Record<string, string> = {
        name: form.name.trim(),
        source_type: form.source_type,
      }
      if (form.source_url.trim()) body.source_url = form.source_url.trim()
      if (form.version.trim())    body.version    = form.version.trim()

      const res = await fetch('/api/admin/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json() as { error?: unknown }
      if (!res.ok) {
        setError(typeof data.error === 'string' ? data.error : 'Failed to add integration')
        return
      }
      setOpen(false)
      reset()
      router.refresh()
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Button size="sm" onClick={() => { reset(); setOpen(true) }}>
        <Plus className="h-4 w-4 mr-1.5" />
        Add
      </Button>

      <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); setOpen(v) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add integration</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label htmlFor="int-name">Name</Label>
              <Input
                id="int-name"
                required
                autoFocus
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Slack MCP server"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Source type</Label>
              <Select
                value={form.source_type}
                onValueChange={(v) => setForm((f) => ({ ...f, source_type: v as SourceType }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="git">Git URL</SelectItem>
                  <SelectItem value="official">Official registry</SelectItem>
                  <SelectItem value="local">Local</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {form.source_type !== 'local' && (
              <div className="space-y-1.5">
                <Label htmlFor="int-url">Source URL</Label>
                <Input
                  id="int-url"
                  type="url"
                  value={form.source_url}
                  onChange={(e) => setForm((f) => ({ ...f, source_url: e.target.value }))}
                  placeholder="https://github.com/org/mcp-server-slack"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="int-version">
                Version <span className="text-muted-foreground text-xs">(optional)</span>
              </Label>
              <Input
                id="int-version"
                value={form.version}
                onChange={(e) => setForm((f) => ({ ...f, version: e.target.value }))}
                placeholder="1.0.0"
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={loading}>
                Cancel
              </Button>
              <Button type="submit" disabled={loading || !form.name.trim()}>
                {loading && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
                Add
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
