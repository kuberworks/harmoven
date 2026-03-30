'use client'

// components/task/IntentBanner.tsx
// Classifier result confirmation shown after task input analysis.
// Displays: detected intent, confidence level, suggested domain profile.
// User can confirm or override the detected intent.

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils/cn'
import { Sparkles, ChevronDown, Check } from 'lucide-react'

interface ClassificationResult {
  domain_profile: string
  intent_label: string
  confidence: number // 0–1
  rationale?: string
}

interface IntentBannerProps {
  classification: ClassificationResult
  onConfirm: () => void
  onOverride: (profile: string) => void
  confirmed?: boolean
}

const DOMAIN_DISPLAY: Record<string, string> = {
  data_reporting:   'Data & Reporting',
  app_scaffolding:  'App Development',
  content_creation: 'Content Creation',
  legal_review:     'Legal Review',
  marketing:        'Marketing',
  customer_support: 'Customer Support',
  default:          'General',
}

function confidenceLabel(c: number): { text: string; color: string } {
  if (c >= 0.85) return { text: 'High confidence', color: 'text-green-400' }
  if (c >= 0.65) return { text: 'Medium confidence', color: 'text-amber-400' }
  return { text: 'Low confidence', color: 'text-muted-foreground' }
}

export function IntentBanner({ classification, onConfirm, onOverride, confirmed }: IntentBannerProps) {
  const { text: confText, color: confColor } = confidenceLabel(classification.confidence)
  const domainLabel = DOMAIN_DISPLAY[classification.domain_profile] ?? classification.domain_profile

  if (confirmed) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-green-500/20 bg-green-500/10 px-3 py-2">
        <Check className="h-4 w-4 text-green-400 shrink-0" aria-hidden />
        <span className="text-sm text-green-400 font-medium">
          {domainLabel} — ready to run
        </span>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-amber-400 shrink-0" aria-hidden />
        <span className="text-sm font-medium text-amber-400">Intent detected</span>
        <Badge variant="paused" className="ml-auto text-xs">{domainLabel}</Badge>
      </div>

      {classification.rationale && (
        <p className="text-xs text-muted-foreground leading-relaxed">{classification.rationale}</p>
      )}

      <div className="flex items-center justify-between gap-2 pt-1">
        <span className={cn('text-xs', confColor)}>
          {confText} ({Math.round(classification.confidence * 100)}%)
        </span>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1 text-muted-foreground"
            onClick={() => onOverride(classification.domain_profile)}
          >
            <ChevronDown className="h-3 w-3" aria-hidden />
            Change
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={onConfirm}
          >
            <Check className="h-3.5 w-3.5" aria-hidden />
            Confirm
          </Button>
        </div>
      </div>
    </div>
  )
}
