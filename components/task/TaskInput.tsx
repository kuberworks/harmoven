'use client'

// components/task/TaskInput.tsx
// Free text + optional JSON schema editor for task creation.
// Standard mode: single textarea with character hint.
// Expert mode: side-by-side text + JSON schema override panel.

import { useState } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils/cn'
import { Code2, FileText } from 'lucide-react'

interface TaskInputProps {
  value: string
  onChange: (value: string) => void
  schemaValue?: string
  onSchemaChange?: (value: string) => void
  domainProfile?: string
  placeholder?: string
  expertMode?: boolean
  disabled?: boolean
  maxLength?: number
}

const DOMAIN_HINTS: Record<string, string> = {
  data_reporting:   'Describe the data analysis or report you need…',
  app_scaffolding:  'Describe the application you want to build — platform, stack, features…',
  content_creation: 'Describe the content you need — topic, tone, audience, length…',
  legal_review:     'Describe the document to review and the legal context…',
  default:          'Describe your task in plain language…',
}

export function TaskInput({
  value, onChange,
  schemaValue = '', onSchemaChange,
  domainProfile,
  placeholder,
  expertMode = false,
  disabled = false,
  maxLength = 4000,
}: TaskInputProps) {
  const [showSchema, setShowSchema] = useState(false)
  const hint = placeholder ?? DOMAIN_HINTS[domainProfile ?? 'default'] ?? DOMAIN_HINTS.default
  const chars = value.length

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label htmlFor="task-input-textarea">Task description</Label>
        <div className="flex items-center gap-2">
          <span className={cn('text-xs font-mono', chars > maxLength * 0.9 ? 'text-amber-400' : 'text-muted-foreground')}>
            {chars.toLocaleString()} / {maxLength.toLocaleString()}
          </span>
          {expertMode && onSchemaChange && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={() => setShowSchema((s) => !s)}
            >
              {showSchema ? <FileText className="h-3.5 w-3.5" /> : <Code2 className="h-3.5 w-3.5" />}
              {showSchema ? 'Hide schema' : 'Override schema'}
            </Button>
          )}
        </div>
      </div>

      <div className={cn('grid gap-3', showSchema && expertMode ? 'grid-cols-2' : 'grid-cols-1')}>
        <div className="space-y-1">
          <Textarea
            id="task-input-textarea"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={hint}
            disabled={disabled}
            rows={6}
            maxLength={maxLength}
            className="resize-none font-body text-sm leading-relaxed"
            aria-label="Task description"
          />
          {domainProfile && (
            <div className="flex items-center gap-1.5 pt-0.5">
              <Badge variant="secondary" className="text-xs">
                {domainProfile.replace(/_/g, ' ')}
              </Badge>
              <span className="text-xs text-muted-foreground">domain active</span>
            </div>
          )}
        </div>

        {showSchema && expertMode && (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">JSON schema override</Label>
            <Textarea
              value={schemaValue}
              onChange={(e) => onSchemaChange?.(e.target.value)}
              placeholder='{ "type": "object", "properties": { … } }'
              disabled={disabled}
              rows={6}
              className="resize-none font-mono text-xs"
              aria-label="JSON schema override"
            />
          </div>
        )}
      </div>
    </div>
  )
}
