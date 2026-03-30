// components/run/CostMeter.tsx
// Permission-gated cost display.
// Renders nothing when showCosts is false — never shows placeholder.
// Permission required: stream:costs (checked by the Server Component calling this).

import { cn } from '@/lib/utils/cn'

interface CostMeterProps {
  /** Cost in USD as a number (converted from Prisma Decimal before passing) */
  costUsd: number
  /** Permission gate — false = render nothing */
  showCosts: boolean
  /** Token count (optional, shown in Expert Mode) */
  tokensActual?: number
  showTokens?: boolean
  className?: string
}

function formatCost(usd: number): string {
  if (usd === 0) return '€0.00'
  if (usd < 0.001) return `€${(usd * 1000).toFixed(3)}m`
  return `€${usd.toFixed(4)}`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}

export function CostMeter({ costUsd, showCosts, tokensActual, showTokens, className }: CostMeterProps) {
  if (!showCosts) return null

  return (
    <span className={cn('inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground', className)}>
      <span>{formatCost(costUsd)}</span>
      {showTokens && tokensActual !== undefined && tokensActual > 0 && (
        <>
          <span className="opacity-40">·</span>
          <span>{formatTokens(tokensActual)} tok</span>
        </>
      )}
    </span>
  )
}
