'use client'
// app/(app)/marketplace/upload-tab.tsx
// Upload a .hpkg package file (ZIP).
// Admin only — guarded by the parent page's isAdmin check.

import { useState, useRef, useCallback, DragEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Upload,
  FileArchive,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  X,
} from 'lucide-react'

interface ManifestPreview {
  pack_id:         string
  name:            string
  version:         string
  author?:         string
  description?:    string
  capability_type: string
  tags?:           string[]
}

export function UploadTab() {
  const router = useRouter()

  const [file,         setFile]         = useState<File | null>(null)
  const [dragging,     setDragging]     = useState(false)
  const [importReason, setImportReason] = useState('')
  const [uploading,    setUploading]    = useState(false)
  const [error,        setError]        = useState<string | null>(null)
  const [success,      setSuccess]      = useState<string | null>(null)
  const [preview,      setPreview]      = useState<ManifestPreview | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)

  const reset = useCallback(() => {
    setFile(null)
    setError(null)
    setSuccess(null)
    setPreview(null)
    setImportReason('')
    if (inputRef.current) inputRef.current.value = ''
  }, [])

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    const dropped = e.dataTransfer.files[0]
    if (dropped) {
      if (!dropped.name.endsWith('.hpkg')) {
        setError("Seuls les fichiers .hpkg sont acceptés.")
        return
      }
      setFile(dropped)
      setError(null)
    }
  }, [])

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0]
    if (selected) {
      if (!selected.name.endsWith('.hpkg')) {
        setError("Seuls les fichiers .hpkg sont acceptés.")
        return
      }
      setFile(selected)
      setError(null)
    }
  }, [])

  const handleUpload = async () => {
    if (!file) return
    setError(null)
    setUploading(true)

    try {
      const form = new FormData()
      form.append('file', file)
      if (importReason) form.append('import_reason', importReason)

      const res = await fetch('/api/admin/marketplace/upload', {
        method: 'POST',
        body: form,
      })

      const data = await res.json() as {
        pack_id?: string
        name?: string
        version?: string
        capability_type?: string
        error?: string
        manifest?: ManifestPreview
      }

      if (!res.ok) {
        setError(data.error ?? `Erreur HTTP ${res.status}`)
        return
      }

      setSuccess(`"${data.name ?? file.name}" installé avec succès (désactivé, en attente de révision).`)
      if (data.manifest) setPreview(data.manifest)
      else if (data.pack_id) {
        setPreview({
          pack_id:         data.pack_id,
          name:            data.name ?? '',
          version:         data.version ?? '',
          capability_type: data.capability_type ?? '',
        })
      }
      router.refresh()
    } finally {
      setUploading(false)
    }
  }

  if (success) {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg bg-green-500/10 border border-green-500/20 p-4">
          <CheckCircle2 className="h-4 w-4 text-green-400 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-green-400">{success}</p>
            <p className="text-xs text-muted-foreground">
              Le package est désactivé. Un administrateur doit l&apos;activer dans Admin → MCP Skills.
            </p>
          </div>
        </div>
        {preview && (
          <Card className="rounded-xl border-border/50 bg-card/50">
            <CardContent className="pt-4 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Manifeste</p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div><span className="text-muted-foreground">Pack ID :</span> <span className="font-mono">{preview.pack_id}</span></div>
                <div><span className="text-muted-foreground">Version :</span> <span>{preview.version}</span></div>
                <div><span className="text-muted-foreground">Type :</span> <Badge variant="outline" className="text-xs py-0">{preview.capability_type}</Badge></div>
                {preview.author && <div><span className="text-muted-foreground">Auteur :</span> <span>{preview.author}</span></div>}
              </div>
            </CardContent>
          </Card>
        )}
        <Button variant="outline" size="sm" onClick={reset}>Importer un autre paquet</Button>
      </div>
    )
  }

  return (
    <div className="space-y-4 max-w-2xl">
      {/* Drop zone */}
      <div
        onDragEnter={() => setDragging(true)}
        onDragLeave={() => setDragging(false)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        onClick={() => !file && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && !file && inputRef.current?.click()}
        aria-label="Zone de dépôt de fichier .hpkg"
        className={`
          relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed py-10 px-6 text-center transition-colors cursor-pointer
          ${dragging ? 'border-amber-500/70 bg-amber-500/5' : 'border-border/50 hover:border-border hover:bg-muted/30'}
          ${file ? 'cursor-default' : ''}
        `}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".hpkg"
          className="hidden"
          onChange={handleFileChange}
          aria-label="Sélectionner un fichier .hpkg"
        />

        {file ? (
          <div className="flex items-center gap-2">
            <FileArchive className="h-5 w-5 text-amber-400" />
            <span className="text-sm font-medium">{file.name}</span>
            <span className="text-xs text-muted-foreground">({(file.size / 1024).toFixed(0)} Ko)</span>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 ml-1 text-muted-foreground hover:text-red-400"
              onClick={(e) => { e.stopPropagation(); reset() }}
              aria-label="Retirer le fichier"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <>
            <Upload className="h-8 w-8 text-muted-foreground/50" />
            <div>
              <p className="text-sm font-medium text-foreground">
                Glissez-déposez un fichier <span className="font-mono">.hpkg</span> ici
              </p>
              <p className="text-xs text-muted-foreground mt-1">ou cliquez pour sélectionner (max 10 Mo)</p>
            </div>
          </>
        )}
      </div>

      {/* Import reason */}
      <div className="space-y-1.5">
        <Label className="text-xs">Raison d&apos;import (optionnel)</Label>
        <Input
          value={importReason}
          onChange={(e) => setImportReason(e.target.value)}
          placeholder="Ex: Package interne validé par l'équipe sécurité le …"
          className="h-9"
        />
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      <Button
        onClick={handleUpload}
        disabled={!file || uploading}
        size="sm"
        className="gap-2"
      >
        {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
        {uploading ? 'Upload en cours…' : 'Importer le package'}
      </Button>
    </div>
  )
}
