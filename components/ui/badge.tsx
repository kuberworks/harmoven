import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils/cn'

const badgeVariants = cva(
  'inline-flex items-center rounded-badge border px-2 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring',
  {
    variants: {
      variant: {
        default:     'border-transparent bg-primary text-primary-foreground',
        secondary:   'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
        destructive: 'border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80',
        outline:     'text-foreground border-border',
        // Status variants
        running:   'border-transparent bg-[var(--color-status-running)]/20 text-[var(--color-status-running)]',
        completed: 'border-transparent bg-[var(--color-status-completed)]/20 text-[var(--color-status-completed)]',
        failed:    'border-transparent bg-[var(--color-status-failed)]/20 text-[var(--color-status-failed)]',
        paused:    'border-transparent bg-[var(--color-status-paused)]/20 text-[var(--color-status-paused)]',
        suspended: 'border-transparent bg-[var(--color-status-suspended)]/20 text-[var(--color-status-suspended)]',
        pending:   'border-transparent bg-[var(--color-status-pending)]/20 text-[var(--color-status-pending)]',
      },
    },
    defaultVariants: { variant: 'default' },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
