'use client'
// app/(app)/admin/marketplace/smart-import-section.tsx
// Smart Import (A.4) configuration tab — admin only.
//
// Allows instance admins to:
//   - Enable/disable Smart Import (master switch)
//   - Select LLM provider/model for the relevance gate + adapter
//   - Set max_tokens, preview_ttl_hours, monthly_budget_usd
//   - View current monthly LLM cost via /api/admin/marketplace/import-history

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Loader2, Sparkles, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'

// ─── Types ────────────────────────────────────────────────────────────────────

interface LlmProfile {
  id:       string
  provider: string
  model_string: string
  tier:     string
}

interface SmartImportConfig {
  enabled:             boolean
  provider_id:         string | null
  model:               string | null
  max_tokens:          number
  preview_ttl_hours:   number
  monthly_budget_usd:  number | null
}

interface BudgetInfo {
  monthly_cost_usd:    number
  monthly_budget_usd:  number | null
  budget_percent_used: number | null
  monthly_llm_calls:   number
}

interface SmartImportSectionProps {
  initialConfig: SmartImportConfig
  profiles:      LlmProfile[]
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SmartImportSection({ initialConfig, profiles }: SmartImportSectionProps) {
  const { toast } = useToast()

  const [config,   setConfig]   = useState<SmartImportConfig>(initialConfig)
  const [saving,   setSaving]   = useState(false)
  const [budget,   setBudget]   = useState<BudgetInfo | null>(null)
  const [dirty,    setDirty]    = useState(false)

  // Load monthly cost on mount
  useEffect(() => {
    fetch('/api/admin/marketplace/import-history?size=1')
      .then((r) => r.json() as Promise<BudgetInfo & { data: unknown[] }>)
      .then((data) => setBudget({
        monthly_cost_usd:    data.monthly_cost_usd,
        monthly_budget_usd:  data.monthly_budget_usd,
        budget_percent_used: data.budget_percent_used ?? null,
        monthly_llm_calls:   data.monthly_llm_calls ?? 0,
      }))
      .catch(() => { /* non-fatal */ })
  }, [])

  function update<K extends keyof SmartImportConfig>(key: K, value: SmartImportConfig[K]) {
    setConfig((prev) => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  async function handleSave() {
    setSaving(true)
    try {
      const settings: Record<string, string | null> = {
        'marketplace.smart_import.enabled':           String(config.enabled),
        'marketplace.smart_import.max_tokens':        String(config.max_tokens),
        'marketplace.smart_import.preview_ttl_hours': String(config.preview_ttl_hours),
        'marketplace.smart_import.provider_id':       config.provider_id,
        'marketplace.smart_import.model':             config.model,
        'marketplace.smart_import.monthly_budget_usd': config.monthly_budget_usd !== null
          ? String(config.monthly_budget_usd)
          : null,
      }

      const res = await fetch('/api/admin/marketplace/smart-import-settings', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ settings }),
      })

      if (!res.ok) {
        const err = await res.json() as { error: string }
        toast({ title: 'Erreur lors de la sauvegarde', description: err.error, variant: 'destructive' })
        return
      }

      toast({ title: 'Configuration Smart Import sauvegardée' })
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  const budgetPercent = budget?.budget_percent_used ?? 0
  const budgetColor =
    budgetPercent >= 100 ? 'bg-red-500'
    : budgetPercent >= 80 ? 'bg-amber-500'
    : 'bg-green-500'

  return (
    <Card className="rounded-xl border-border/50 bg-card/50">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="h-4 w-4 text-amber-500" />
          Smart Import (analyse LLM)
        </CardTitle>
        <CardDescription className="text-xs mt-1">
          Analyse de pertinence et génération automatique de manifeste via LLM pour les imports Git.
          Désactivé par défaut — aucun appel LLM sans activation explicite.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Master switch */}
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">Activer Smart Import</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Active la détection de pertinence et l&apos;adaptateur LLM dans l&apos;onglet &quot;Add from Git&quot;.
            </p>
          </div>
          <Switch
            checked={config.enabled}
            onCheckedChange={(v) => update('enabled', v)}
            aria-label="Toggle Smart Import"
          />
        </div>

        {config.enabled && (
          <>
            {/* LLM configuration */}
            <div className="space-y-3 border-t border-border/30 pt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Configuration LLM
              </p>

              {profiles.length === 0 ? (
                <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-xs text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  Aucun provider LLM configuré. Activez un provider dans Admin → Modèles LLM.
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Profil LLM</Label>
                    <Select
                      value={config.provider_id ?? ''}
                      onValueChange={(v) => {
                        const p = profiles.find((pr) => pr.id === v)
                        update('provider_id', v)
                        update('model', p?.model_string ?? null)
                      }}
                    >
                      <SelectTrigger className="h-9 text-xs">
                        <SelectValue placeholder="Sélectionner un profil…" />
                      </SelectTrigger>
                      <SelectContent>
                        {profiles.map((p) => (
                          <SelectItem key={p.id} value={p.id} className="text-xs">
                            <span className="font-medium">{p.id}</span>
                            <span className="ml-2 text-muted-foreground">({p.tier})</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs">Max tokens par appel</Label>
                    <Input
                      type="number"
                      min={500}
                      max={32000}
                      value={config.max_tokens}
                      onChange={(e) => update('max_tokens', parseInt(e.target.value, 10) || 4000)}
                      className="h-9 text-xs"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Budget + TTL */}
            <div className="space-y-3 border-t border-border/30 pt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Budget &amp; TTL
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Budget mensuel LLM (USD, vide = illimité)</Label>
                  <Input
                    type="number"
                    min={0}
                    step={0.01}
                    placeholder="ex. 50.00"
                    value={config.monthly_budget_usd ?? ''}
                    onChange={(e) => {
                      const v = e.target.value
                      update('monthly_budget_usd', v === '' ? null : parseFloat(v))
                    }}
                    className="h-9 text-xs"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">TTL preview (heures, 1–168)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={168}
                    value={config.preview_ttl_hours}
                    onChange={(e) => update('preview_ttl_hours', parseInt(e.target.value, 10) || 24)}
                    className="h-9 text-xs"
                  />
                </div>
              </div>

              {/* Budget usage bar */}
              {budget && budget.monthly_budget_usd !== null && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Dépenses ce mois</span>
                    <span className={budgetPercent >= 100 ? 'text-red-400' : budgetPercent >= 80 ? 'text-amber-400' : ''}>
                      ${budget.monthly_cost_usd.toFixed(2)} / ${budget.monthly_budget_usd.toFixed(2)}
                      <span className="ml-1 text-muted-foreground">({budgetPercent}%)</span>
                    </span>
                  </div>
                  <Progress value={Math.min(budgetPercent, 100)} className="h-1.5" />
                  {budgetPercent >= 100 && (
                    <div className="flex items-center gap-1.5 text-xs text-red-400">
                      <AlertTriangle className="h-3 w-3" /> Budget épuisé — les imports LLM sont bloqués.
                    </div>
                  )}
                  {budgetPercent >= 80 && budgetPercent < 100 && (
                    <div className="flex items-center gap-1.5 text-xs text-amber-400">
                      <AlertTriangle className="h-3 w-3" /> {budgetPercent}% du budget utilisé.
                    </div>
                  )}
                </div>
              )}

              {budget && (
                <p className="text-xs text-muted-foreground">
                  {budget.monthly_llm_calls} appel(s) LLM ce mois ·{' '}
                  ${budget.monthly_cost_usd.toFixed(4)} dépensé
                </p>
              )}
            </div>
          </>
        )}

        {/* Save button */}
        <div className="flex justify-end border-t border-border/30 pt-4">
          <Button size="sm" onClick={handleSave} disabled={saving || !dirty} className="gap-2">
            {saving
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Sauvegarde…</>
              : dirty
              ? 'Sauvegarder'
              : <><CheckCircle2 className="h-3.5 w-3.5 text-green-400" /> Sauvegardé</>
            }
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
